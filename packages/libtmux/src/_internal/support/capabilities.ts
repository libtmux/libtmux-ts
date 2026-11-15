import type {
  CapabilityCommand,
  CapabilityId,
  CapabilityRecord,
  ServerCapabilities,
  WorkaroundId,
  WorkaroundRecord,
} from "../../types.js";
import type { TmuxCapabilities } from "../runtime/capabilities.js";
import {
  parseTmuxVersion,
  tmuxVersionAtLeast,
  tmuxVersionIsExact,
  type TmuxVersion,
} from "../runtime/tmux_version.js";
import { MINIMUM_TMUX } from "./minimum.js";

/**
 * What a daemon can do, and where this package works around it.
 *
 * One table decides both behaviour and the published manifest: the feature
 * gates read their releases from here, and `capabilities.json` at the
 * repository root is this table serialized. API names are spelled the way the
 * generated API model spells them: `module.Class.member`.
 */

export const CAPABILITIES: readonly CapabilityRecord[] = [
  {
    id: "control-mode",
    name: "Control mode",
    summary: "Attach a library-managed control client and stream events.",
    since: "3.7",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: ["server.Server.watch", "server.Server.connect"],
    commands: [{ command: "attach-session", flags: ["-C"] }],
  },
  {
    id: "buffer-delete-named",
    name: "Named buffer deletion",
    summary: "Delete one paste buffer by name without risking another buffer.",
    since: "3.4",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: [
      "server.Server.deleteBuffer",
      "server.Server.cmd",
      "server.Server.pipeline",
      "server.Server.batch",
    ],
    commands: [{ command: "delete-buffer", flags: ["-b"] }],
  },
  {
    id: "buffer-rename",
    name: "Buffer rename",
    summary: "Rename a paste buffer without risking another buffer.",
    since: "3.4",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: [
      "server.Server.setBuffer",
      "server.Server.cmd",
      "server.Server.pipeline",
      "server.Server.batch",
    ],
    commands: [{ command: "set-buffer", flags: ["-b", "-n"] }],
  },
  {
    id: "layout-without-checksum",
    name: "Layouts without a checksum",
    summary: "Apply a layout string or a named layout that tmux validates before use.",
    since: "3.4",
    handling: "refuse",
    error: "errors.TmuxTransportError",
    apis: [
      "window.Window.selectLayout",
      "server.Server.cmd",
      "server.Server.pipeline",
      "server.Server.batch",
    ],
    commands: [{ command: "select-layout" }],
  },
  {
    id: "layout-mirrored-main",
    name: "Mirrored main layouts",
    summary: "Apply main-horizontal-mirrored and main-vertical-mirrored.",
    since: "3.5",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: ["window.Window.selectLayout", "server.Server.validateLayouts"],
    commands: [{ command: "select-layout" }],
  },
  {
    id: "layout-json",
    name: "JSON layout strings",
    summary: "Apply a layout saved in the JSON form tmux reports.",
    since: "3.8",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: ["window.Window.selectLayout", "server.Server.validateLayouts"],
    commands: [{ command: "select-layout" }],
  },
  {
    id: "program-run",
    name: "Program runs",
    summary:
      "Run a program in a detached pane and learn of its exit from tmux; 3.7 through 3.7c keep a dead pane's pipe open.",
    since: "3.8",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: ["server.Server.spawn", "server.Server.run"],
    commands: [
      { command: "wait-for", flags: ["-E", "-F"] },
      { command: "respawn-pane", flags: ["-k"] },
      { command: "pipe-pane", flags: ["-O"] },
    ],
  },
  {
    id: "pane-wait",
    name: "Pane waits",
    summary:
      "Wait for any pane's program to exit, or its shell's command to finish, through tmux's own events.",
    since: "3.8",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: ["pane.Pane.waitForExit", "pane.Pane.waitForCommand"],
    commands: [{ command: "wait-for", flags: ["-E", "-F", "-v"] }],
  },
  {
    id: "clipboard-query",
    name: "Clipboard query",
    summary: "Ask an attached client's terminal for its clipboard with refresh-client -l.",
    since: "3.6a",
    handling: "refuse",
    error: "errors.VersionTooLowError",
    apis: ["server.Server.cmd", "server.Server.pipeline", "server.Server.batch"],
    commands: [{ command: "refresh-client", flags: ["-l"] }],
  },
];

export const WORKAROUNDS: readonly WorkaroundRecord[] = [
  {
    id: "run-shell-output-in-copy-mode",
    name: "run-shell output capture",
    summary:
      "tmux 3.3 through 3.4 send run-shell output to a pane's copy-mode buffer and exit zero; runShell refuses it.",
    releases: ["3.3a", "3.4"],
    fixedIn: "3.5",
    handling: "refuse",
    apis: ["server.Server.runShell"],
    commands: [{ command: "run-shell" }],
  },
  {
    id: "break-pane-misnames-windows",
    name: "break-pane window naming",
    summary:
      "tmux 3.7 accepts break-pane -n and ignores it, and crashes the server on a break-pane without -n; breakOut names the window afterwards and is refused when no name is given, and a raw argv without -n, or with -n and without -P, is refused.",
    releases: ["3.7"],
    handling: "repair",
    apis: ["pane.Pane.breakOut"],
    commands: [{ command: "break-pane", flags: ["-n"] }],
  },
  {
    id: "split-window-percent-size",
    name: "split-window -p",
    summary: "split-window -p is broken on tmux 3.4; a raw argv using it is refused, write -l N%.",
    releases: ["3.4"],
    handling: "refuse",
    apis: ["server.Server.cmd", "server.Server.pipeline", "server.Server.batch"],
    commands: [{ command: "split-window", flags: ["-p"] }],
  },
  {
    id: "name-separators-rejected",
    name: "Colon and dot in names",
    summary:
      "tmux 3.7 rejects ':' and '.' in session and window names after partly running; a raw argv carrying one is refused.",
    releases: ["3.7"],
    handling: "refuse",
    apis: ["server.Server.cmd", "server.Server.pipeline", "server.Server.batch"],
    commands: [
      { command: "new-session", flags: ["-s"] },
      { command: "new-window", flags: ["-n"] },
      { command: "rename-session" },
      { command: "rename-window" },
    ],
  },
];

function capabilityRecord(id: CapabilityId): CapabilityRecord {
  return CAPABILITIES.find((record) => record.id === id)!;
}

function workaroundRecord(id: WorkaroundId): WorkaroundRecord {
  return WORKAROUNDS.find((record) => record.id === id)!;
}

/** The first release a capability works on. */
export function capabilitySince(id: CapabilityId): TmuxVersion {
  return parseTmuxVersion(capabilityRecord(id).since);
}

/** Whether the running release has a capability. */
export function hasCapability(id: CapabilityId, running: TmuxVersion): boolean {
  const record = capabilityRecord(id);
  return (
    tmuxVersionAtLeast(running, parseTmuxVersion(record.since)) &&
    !(record.except ?? []).includes(running.raw)
  );
}

/** Whether the running release has the defect a workaround covers. */
export function workaroundApplies(id: WorkaroundId, running: TmuxVersion): boolean {
  const record = workaroundRecord(id);
  if (record.releases.some((raw) => tmuxVersionIsExact(running, parseTmuxVersion(raw))))
    return true;
  return (
    record.fixedIn !== undefined &&
    tmuxVersionAtLeast(running, parseTmuxVersion(MINIMUM_TMUX)) &&
    !tmuxVersionAtLeast(running, parseTmuxVersion(record.fixedIn))
  );
}

/** The first release without a defect that every earlier release has. */
export function workaroundFixedIn(id: WorkaroundId): string {
  const { fixedIn } = workaroundRecord(id);
  if (fixedIn === undefined) throw new TypeError(`${id} names no release that fixes it`);
  return fixedIn;
}

function frozenCommands(commands: readonly CapabilityCommand[]): readonly CapabilityCommand[] {
  return Object.freeze(
    commands.map((command) =>
      Object.freeze({
        ...command,
        ...(command.flags === undefined ? {} : { flags: Object.freeze([...command.flags]) }),
      }),
    ),
  );
}

/** Describe a captured identity without giving callers references to admission rules. */
export function capabilityReport(
  captured: Omit<TmuxCapabilities, "tmuxVersion">,
): ServerCapabilities {
  const version = parseTmuxVersion(captured.rawVersion);
  const features = Object.fromEntries(
    CAPABILITIES.map((record) => {
      const supported = hasCapability(record.id, version);
      const reason = supported
        ? `Available on tmux ${version.raw}.`
        : record.except?.includes(version.raw) === true
          ? `Unavailable on tmux ${version.raw}; this release is excluded.`
          : `Requires tmux ${record.since}; the connected daemon reports ${version.raw}.`;
      return [
        record.id,
        Object.freeze({
          ...record,
          apis: Object.freeze([...record.apis]),
          commands: frozenCommands(record.commands),
          ...(record.except === undefined ? {} : { except: Object.freeze([...record.except]) }),
          supported,
          reason,
        }),
      ];
    }),
  ) as ServerCapabilities["features"];
  const workarounds = Object.fromEntries(
    WORKAROUNDS.map((record) => {
      const active = workaroundApplies(record.id, version);
      return [
        record.id,
        Object.freeze({
          ...record,
          apis: Object.freeze([...record.apis]),
          commands: frozenCommands(record.commands),
          releases: Object.freeze([...record.releases]),
          active,
          reason: `${active ? "Applies" : "Does not apply"} to tmux ${version.raw}.`,
        }),
      ];
    }),
  ) as ServerCapabilities["workarounds"];
  return Object.freeze({
    version: version.raw,
    minimumVersion: MINIMUM_TMUX,
    daemonIdentity: Object.freeze({ ...captured.daemon }),
    connectionAlias: captured.connectionAlias,
    daemonEpoch: captured.daemonEpoch,
    fingerprint: captured.fingerprint,
    features: Object.freeze(features),
    workarounds: Object.freeze(workarounds),
  });
}

/** The manifest the docs read: `libtmux-capabilities/1`. */
export interface CapabilityManifest {
  readonly schema: "libtmux-capabilities/1";
  readonly port: "ts";
  readonly floor: { readonly minimum: string };
  readonly capabilities: readonly CapabilityRecord[];
  readonly workarounds: readonly Omit<WorkaroundRecord, "fixedIn">[];
}

export function capabilityManifest(): CapabilityManifest {
  return {
    schema: "libtmux-capabilities/1",
    port: "ts",
    floor: { minimum: MINIMUM_TMUX },
    capabilities: CAPABILITIES,
    workarounds: WORKAROUNDS.map(({ fixedIn: _fixedIn, ...record }: WorkaroundRecord) => record),
  };
}

const PRINT_WIDTH = 100;

/**
 * Two-space JSON in the shape the repository formatter keeps: objects stay
 * expanded, and an array of strings shares its key's line when it fits.
 */
function render(value: unknown, depth: number, lead: string, trail: string): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${lead}[]${trail}`;
    if (value.every((item) => typeof item === "string")) {
      const inline = `${lead}${JSON.stringify(value).replaceAll('","', '", "')}${trail}`;
      if (pad.length + inline.length <= PRINT_WIDTH) return inline;
    }
    const items = value.map((item, index) =>
      render(item, depth + 1, "  ".repeat(depth + 1), index === value.length - 1 ? "" : ","),
    );
    return `${lead}[\n${items.join("\n")}\n${pad}]${trail}`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const fields = entries.map(([key, field], index) =>
      render(
        field,
        depth + 1,
        `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: `,
        index === entries.length - 1 ? "" : ",",
      ),
    );
    return `${lead}{\n${fields.join("\n")}\n${pad}}${trail}`;
  }
  return `${lead}${JSON.stringify(value)}${trail}`;
}

/** The manifest as committed: formatter-stable JSON with a trailing newline. */
export function renderCapabilityManifest(): string {
  return `${render(capabilityManifest(), 0, "", "")}\n`;
}
