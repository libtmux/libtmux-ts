import { PANE_DIRECTION_FLAG_MAP, WINDOW_DIRECTION_FLAG_MAP } from "../../constants.js";
import type { CommandOptions } from "../../common.js";
import type { DaemonGuard } from "../../engine.js";
import { LibTmuxError, TmuxCommandError } from "../../errors.js";
import {
  splitSize as authenticateSplitSize,
  type NewSessionOptions,
  type NewWindowOptions,
  type PlanOptions,
  type PlannedOperation,
  type ServerSnapshot,
  type SplitOptions,
} from "../../types.js";
import type { Pane } from "../../pane.js";
import type { Session } from "../../session.js";
import type { Window } from "../../window.js";
import { quoteCommand } from "../transport/lexer.js";
import { uniqueUnknownCommand } from "../transport/refusal.js";
import { assertName } from "./names.js";

/** What a plan carries of the options its direct call would honour. */
function planOptions(options: CommandOptions): NonNullable<PlannedOperation<unknown>["options"]> {
  const { signal, timeoutMs } = options;
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * Refuse the one option a plan cannot carry.
 *
 * The types already do; this is for the caller they do not reach, because a
 * `stdin` that is accepted and ignored reads as one that was fed.
 */
export function refuseStdin(options: object | undefined, builder: string): void {
  if ((options as { readonly stdin?: unknown } | undefined)?.stdin !== undefined) {
    throw new TypeError(
      `${builder} describes a command without running it, so it takes no stdin: a plan honours signal and timeoutMs, and stdin belongs to the direct call.`,
    );
  }
}

/** Read a plan's result, handing it a snapshot only when it declared it needs one. */
export function resolvePlan<T>(
  plan: PlannedOperation<T>,
  snapshot: ServerSnapshot | undefined,
  lines: readonly string[],
): T {
  if (plan.needsSnapshot === false) return plan.resolve(undefined, lines);
  if (snapshot === undefined) {
    throw new LibTmuxError(`${plan.argv[0] ?? "a plan"} needs a snapshot and none was taken`);
  }
  return plan.resolve(snapshot, lines);
}

function requireIdentity(lines: readonly string[], command: string): string {
  const identity = lines[0];
  if (identity === undefined || identity === "") {
    throw new LibTmuxError(`${command} did not report the created object's identity`);
  }
  return identity;
}

/** Shared by every plan that creates something and then has to find it again. */
function found<T>(created: T | undefined, command: string, identity: string): T {
  if (created === undefined) {
    throw new LibTmuxError(`${command} created ${identity} but it was gone before it resolved`);
  }
  return created;
}

function newSessionArgs(options: NewSessionOptions): readonly string[] {
  return [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    ...(options.name === undefined ? [] : ["-s", assertName("session", options.name)]),
    ...(options.groupWith === undefined ? [] : ["-t", options.groupWith]),
    ...(options.windowName === undefined ? [] : ["-n", assertName("window", options.windowName)]),
    ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
    ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    // A detached session has no client to size it, so tmux picks 80x24 and
    // every program in it formats to that. This is the only place the size can
    // be chosen at creation.
    ...(options.width === undefined ? [] : ["-x", String(options.width)]),
    ...(options.height === undefined ? [] : ["-y", String(options.height)]),
    // tmux reads its trailing arguments as the command; `--` keeps one that
    // begins with a dash from being taken for a flag.
    ...(options.shellCommand === undefined ? [] : ["--", options.shellCommand]),
  ];
}

function newWindowArgs(
  sessionId: string | null,
  options: PlanOptions<NewWindowOptions>,
): readonly string[] {
  if (options.index !== undefined) {
    if (!Number.isInteger(options.index) || options.index < 0 || options.index > 2_147_483_647) {
      throw new TypeError("window index must be an integer from 0 to 2147483647");
    }
    if (options.direction !== undefined) {
      throw new TypeError("window index cannot be combined with direction");
    }
  }
  const target =
    options.index === undefined ? sessionId : `${sessionId ?? ""}:${String(options.index)}`;
  return [
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id}",
    ...(target == null ? [] : ["-t", target]),
    ...(options.name === undefined ? [] : ["-n", assertName("window", options.name)]),
    ...(options.direction === undefined ? [] : [WINDOW_DIRECTION_FLAG_MAP[options.direction]]),
    ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
    ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    ...(options.shellCommand === undefined ? [] : ["--", options.shellCommand]),
  ];
}

function renderSplitSize(value: NonNullable<SplitOptions["size"]>): string {
  return String(authenticateSplitSize(value));
}

function splitWindowArgs(
  target: string | null,
  options: PlanOptions<SplitOptions>,
): readonly string[] {
  if (options.direction !== undefined && options.vertical !== undefined) {
    throw new TypeError("Choose direction without the deprecated vertical option");
  }
  return [
    "split-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    ...(options.direction === undefined
      ? options.vertical === false
        ? ["-h"]
        : []
      : PANE_DIRECTION_FLAG_MAP[options.direction]),
    ...(target == null ? [] : ["-t", target]),
    ...(options.size === undefined ? [] : ["-l", renderSplitSize(options.size)]),
    ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
    ...Object.entries(options.environment ?? {}).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]),
    ...(options.shellCommand === undefined ? [] : ["--", options.shellCommand]),
  ];
}

export function planNewSession(options: NewSessionOptions = {}): PlannedOperation<Session> {
  return {
    argv: newSessionArgs(options),
    options: planOptions(options),
    resolve: (snapshot, lines) => {
      const identity = requireIdentity(lines, "new-session");
      return found(snapshot.sessions.first({ id: identity }), "new-session", identity);
    },
  };
}

export function planNewWindow(
  sessionId: string | null,
  options: PlanOptions<NewWindowOptions> = {},
): PlannedOperation<Window> {
  return {
    argv: newWindowArgs(sessionId, options),
    options: planOptions(options),
    resolve: (snapshot, lines) => {
      const identity = requireIdentity(lines, "new-window");
      return found(
        snapshot.windows
          .filter(
            (window: Window) => window.id === identity && window.format.session_id === sessionId,
          )
          .first(),
        "new-window",
        identity,
      );
    },
  };
}

export function planSplitWindow(
  target: string | null,
  options: PlanOptions<SplitOptions> = {},
): PlannedOperation<Pane> {
  return {
    argv: splitWindowArgs(target, options),
    options: planOptions(options),
    resolve: (snapshot, lines) => {
      const identity = requireIdentity(lines, "split-window");
      return found(snapshot.panes.first({ id: identity }), "split-window", identity);
    },
  };
}

export function planKill(
  command: "kill-pane" | "kill-session" | "kill-window",
  target: string | null,
): PlannedOperation<void> {
  return {
    argv: [command, ...(target == null ? [] : ["-t", target])],
    needsSnapshot: false,
    resolve: () => undefined,
  };
}

function conditionalTargetMutation(
  target: string,
  condition: string,
  command: readonly string[],
  refusalReason: string,
): readonly string[] {
  return [
    "if-shell",
    "-F",
    "-t",
    target,
    condition,
    quoteCommand(command),
    quoteCommand([uniqueUnknownCommand(refusalReason)]),
  ];
}

/** Destroy a pane only while its window has one placement. */
export function planKillPaneIfUnshared(target: string): PlannedOperation<void> {
  return {
    argv: conditionalTargetMutation(
      target,
      "#{==:#{window_linked},0}",
      ["kill-pane", "-t", target],
      "shared-window",
    ),
    needsSnapshot: false,
    resolve: () => undefined,
  };
}

/**
 * A window placement as tmux addresses one, and the window it was captured as.
 *
 * `session:index` names a slot, and a window can leave it while a handle still
 * holds the index. The window id says which window the caller meant.
 */
export interface Placement {
  /** The daemon the handle was read from, so tmux refuses the command on any other. */
  readonly daemon?: DaemonGuard | undefined;
  readonly target: string;
  readonly windowId: string;
}

/**
 * Run `command` only while tmux finds each captured window at its placement.
 *
 * The comparison is made by tmux in the same command queue that then runs the
 * command, so nothing can reorder windows between the check and the act. A
 * mismatch, or an index that holds no window at all, runs a unique unknown
 * command instead, which fails the invocation and leaves the command unrun, as
 * {@link planRemoveWindowPlacement}'s group check does. The first placement is
 * checked first; a swap guards both by passing both.
 */
export function guardPlacements(
  placements: readonly Pick<Placement, "target" | "windowId">[],
  command: readonly string[],
): readonly string[] {
  return placements.reduceRight(
    (inner, placement) =>
      conditionalTargetMutation(
        placement.target,
        `#{==:#{window_id},${placement.windowId}}`,
        inner,
        "placement-moved",
      ),
    command,
  );
}

/**
 * Say plainly that a placement no longer holds the window a handle captured.
 *
 * tmux can only report the guard's refusal as an unknown command, so this
 * recognises it by its prefix and returns a readable error that keeps the
 * original as its cause. Anything else comes back unchanged.
 */
export function placementRefusal(error: unknown): unknown {
  if (
    error instanceof TmuxCommandError &&
    error.stderr.some((line) => line.includes("unknown command: libtmux-placement-moved-"))
  ) {
    return new LibTmuxError(
      "the window is no longer at the placement this handle names; read it back from a fresh snapshot",
      { cause: error },
    );
  }
  return error;
}

/** Remove one ungrouped placement, destroying the window only when it is last. */
export function planRemoveWindowPlacement(placement: Placement): PlannedOperation<void> {
  return {
    argv: guardPlacements(
      [placement],
      conditionalTargetMutation(
        placement.target,
        "#{==:#{session_grouped},0}",
        ["unlink-window", "-k", "-t", placement.target],
        "grouped-session",
      ),
    ),
    needsSnapshot: false,
    resolve: () => undefined,
  };
}
