import { PANE_DIRECTION_FLAG_MAP, WINDOW_DIRECTION_FLAG_MAP } from "../../constants.js";
import { LibTmuxException } from "../../exc.js";
import type {
  NewSessionOptions,
  NewWindowOptions,
  PlannedOperation,
  SplitOptions,
} from "../../types.js";
import type { Pane } from "../../pane.js";
import type { Session } from "../../session.js";
import type { Window } from "../../window.js";

function requireIdentity(lines: readonly string[], command: string): string {
  const identity = lines[0];
  if (identity === undefined || identity === "") {
    throw new LibTmuxException(`${command} did not report the created object's identity`);
  }
  return identity;
}

/** Shared by every plan that creates something and then has to find it again. */
function found<T>(created: T | undefined, command: string, identity: string): T {
  if (created === undefined) {
    throw new LibTmuxException(`${command} created ${identity} but it was gone before it resolved`);
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
    ...(options.name === undefined ? [] : ["-s", options.name]),
    ...(options.windowName === undefined ? [] : ["-n", options.windowName]),
    ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
    // tmux reads its trailing arguments as the command; `--` keeps one that
    // begins with a dash from being taken for a flag.
    ...(options.shellCommand === undefined ? [] : ["--", options.shellCommand]),
  ];
}

function newWindowArgs(sessionId: string | null, options: NewWindowOptions): readonly string[] {
  return [
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id}",
    ...(sessionId == null ? [] : ["-t", sessionId]),
    ...(options.name === undefined ? [] : ["-n", options.name]),
    ...(options.direction === undefined ? [] : [WINDOW_DIRECTION_FLAG_MAP[options.direction]]),
    ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
    ...(options.shellCommand === undefined ? [] : ["--", options.shellCommand]),
  ];
}

function splitWindowArgs(target: string | null, options: SplitOptions): readonly string[] {
  return [
    "split-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    // `direction` names the side, which needs the axis and tmux's `-b` for the
    // two sides a boolean cannot reach at all. `vertical` remains for callers
    // that only care about the axis.
    ...(options.direction === undefined
      ? options.vertical === false
        ? ["-h"]
        : []
      : PANE_DIRECTION_FLAG_MAP[options.direction]),
    ...(target == null ? [] : ["-t", target]),
    ...(options.startDirectory === undefined ? [] : ["-c", options.startDirectory]),
    ...(options.shellCommand === undefined ? [] : ["--", options.shellCommand]),
  ];
}

export function planNewSession(options: NewSessionOptions = {}): PlannedOperation<Session> {
  return {
    argv: newSessionArgs(options),
    resolve: (snapshot, lines) => {
      const identity = requireIdentity(lines, "new-session");
      return found(snapshot.sessions.first({ id: identity }), "new-session", identity);
    },
  };
}

export function planNewWindow(
  sessionId: string | null,
  options: NewWindowOptions = {},
): PlannedOperation<Window> {
  return {
    argv: newWindowArgs(sessionId, options),
    resolve: (snapshot, lines) => {
      const identity = requireIdentity(lines, "new-window");
      return found(
        snapshot.windows
          .filter((window: Window) => window.id === identity && window.sessionId === sessionId)
          .first(),
        "new-window",
        identity,
      );
    },
  };
}

export function planSplitWindow(
  target: string | null,
  options: SplitOptions = {},
): PlannedOperation<Pane> {
  return {
    argv: splitWindowArgs(target, options),
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
    resolve: () => undefined,
  };
}
