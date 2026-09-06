/**
 * Where this process is, and where the human is looking.
 *
 * An agent driving tmux has two questions the tmux API does not answer on its
 * own: which pane am I running in, and which panes is somebody watching. The
 * first stops it from typing into its own terminal; the second stops it from
 * typing into someone else's.
 */

import { isAbsolute } from "node:path";

import type { ServerSnapshot } from "libtmux";
import type { Server } from "libtmux/server";

/**
 * What tmux exported into the process it started.
 *
 * `TMUX` is `socketPath,serverPid,sessionIndex`. The pane comes from
 * `TMUX_PANE` rather than from that session index. Input authorization checks
 * both against a fresh topology; a moved pane makes the inherited context stale.
 */
export interface CallerEnvironment {
  readonly problem: string | undefined;
  readonly paneId: string | undefined;
  readonly serverPid: string | undefined;
  readonly sessionId: string | undefined;
  readonly socketPath: string | undefined;
  readonly status: "attached" | "detached" | "invalid";
}

/**
 * Read the caller's tmux context out of the environment.
 *
 * Parsed from the right. tmux writes `"%s,%ld,%d"` with the path first, so the
 * last two fields are the pid and the session index however many commas the
 * path holds — and a socket path may hold one. Only a complete pair of
 * variables is attached; partial or malformed context is unsafe, not detached.
 */
export function readCallerEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CallerEnvironment {
  const raw = environment.TMUX;
  const pane = environment.TMUX_PANE;
  if (raw === undefined && pane === undefined) {
    return {
      paneId: undefined,
      problem: undefined,
      serverPid: undefined,
      sessionId: undefined,
      socketPath: undefined,
      status: "detached",
    };
  }
  const parts = raw?.split(",") ?? [];
  const sessionIndex = parts.at(-1);
  const serverPid = parts.at(-2);
  const socketPath = parts.slice(0, -2).join(",");
  if (
    raw === undefined ||
    pane === undefined ||
    parts.length < 3 ||
    !isAbsolute(socketPath) ||
    !/^[1-9][0-9]*$/u.test(serverPid ?? "") ||
    !/^(?:0|[1-9][0-9]*)$/u.test(sessionIndex ?? "") ||
    !/^%(?:0|[1-9][0-9]*)$/u.test(pane)
  ) {
    return {
      paneId: undefined,
      problem: "The caller's TMUX and TMUX_PANE environment is incomplete or malformed.",
      serverPid: undefined,
      sessionId: undefined,
      socketPath: undefined,
      status: "invalid",
    };
  }
  return {
    paneId: pane,
    problem: undefined,
    serverPid,
    sessionId: `$${sessionIndex}`,
    socketPath,
    status: "attached",
  };
}

export interface ServerAuthority {
  readonly pid: string;
  readonly socketPath: string;
  readonly startTime: string;
}

const AUTHORITY_FORMAT = "#{socket_path}\t#{pid}\t#{start_time}";

/** Read one daemon's physical socket and complete process generation together. */
export async function readServerAuthority(
  tmux: Server,
  signal?: AbortSignal,
): Promise<ServerAuthority> {
  const lines = await tmux.cmd("display-message", ["-p", AUTHORITY_FORMAT], {
    ...(signal === undefined ? {} : { signal }),
    target: null,
  });
  const fields = lines.length === 1 ? lines[0]?.split("\t") : undefined;
  const socketPath = fields?.[0];
  const pid = fields?.[1];
  const startTime = fields?.[2];
  if (
    fields?.length !== 3 ||
    socketPath === undefined ||
    !isAbsolute(socketPath) ||
    !/^[1-9][0-9]*$/u.test(pid ?? "") ||
    !/^[1-9][0-9]*$/u.test(startTime ?? "")
  ) {
    throw new TypeError("tmux returned no usable socket and daemon identity");
  }
  return Object.freeze({ pid: pid ?? "", socketPath, startTime: startTime ?? "" });
}

/** A client tmux is currently drawing for, and what it is showing. */
export interface AttachedClient {
  readonly activePaneId: string | undefined;
  /** A control-mode client is a program, not a person watching a terminal. */
  readonly controlMode: boolean;
  readonly name: string;
  readonly sessionName: string | undefined;
  readonly tty: string | undefined;
}

export interface CallerIdentity {
  /** Panes a human client currently has active, which are the risky ones. */
  readonly attendedPaneIds: readonly string[];
  readonly clients: readonly AttachedClient[];
  /** The pane this MCP process runs in, when it runs inside tmux at all. */
  readonly callerPaneId: string | undefined;
  /**
   * Whether the caller's pane lives on the server this process drives.
   *
   * Requires the physical socket, daemon process, pane, and session to agree
   * with one authenticated observation.
   */
  readonly callerPaneIsOnThisServer: boolean;
  /** A malformed or incoherent caller/client context blocks every pane input route. */
  readonly inputProblem?: string;
  readonly serverPid: string | undefined;
  readonly serverSocketPath?: string;
  readonly serverStartTime?: string;
}

/**
 * Resolve who is where, from one snapshot and one identity read.
 *
 * Takes the snapshot rather than acquiring one so a tool that already has an
 * instant reports on that instant instead of a later one.
 */
export async function resolveCallerIdentity(
  tmux: Server,
  snapshot: ServerSnapshot,
  caller: CallerEnvironment = readCallerEnvironment(),
  authority?: ServerAuthority,
): Promise<CallerIdentity> {
  const observed = authority ?? (await readServerAuthority(tmux));
  const attachedClients = snapshot.clients.toArray();
  const panePlacements = snapshot.panes.toArray();
  let inputProblem = caller.problem;
  const clients = attachedClients.map((client): AttachedClient => ({
    activePaneId: client.pane?.id,
    controlMode: client.controlMode === true,
    name: client.name ?? "",
    sessionName: client.session?.name ?? undefined,
    tty: client.tty ?? undefined,
  }));

  // A terminal client sees every split in its window. Only a confirmed zoom
  // narrows that to its active pane; an absent flag keeps the conservative set.
  const attended = attachedClients.flatMap((client) => {
    if (typeof client.controlMode !== "boolean") {
      inputProblem ??= "A tmux client has no usable control-mode state.";
      return [];
    }
    if (client.controlMode) return [];
    const pane = client.pane;
    if (pane === undefined || !/^%(?:0|[1-9][0-9]*)$/u.test(pane.id)) {
      inputProblem ??= "A terminal tmux client has no usable active-pane state.";
      return [];
    }
    const window = client.window;
    if (window === undefined || typeof window.zoomedFlag !== "boolean") {
      inputProblem ??= "A terminal tmux client has no usable zoom state.";
      return [];
    }
    const sessionId = client.session?.id;
    if (
      !/^\$(?:0|[1-9][0-9]*)$/u.test(sessionId ?? "") ||
      !/^@(?:0|[1-9][0-9]*)$/u.test(window.id)
    ) {
      inputProblem ??= "A terminal tmux client has no usable session or window state.";
      return [];
    }
    const matchesPlacement = (candidate: (typeof panePlacements)[number]): boolean =>
      candidate.format.session_id === sessionId &&
      (candidate.window?.id ?? candidate.format.window_id) === window.id;
    if (
      !panePlacements.some((candidate) => candidate.id === pane.id && matchesPlacement(candidate))
    ) {
      inputProblem ??=
        "A terminal tmux client's active pane disagrees with its session or window placement.";
      return [];
    }
    if (window.zoomedFlag) return [pane.id];
    const visible = window.panes.toArray();
    if (visible.some((candidate) => !/^%(?:0|[1-9][0-9]*)$/u.test(candidate.id))) {
      inputProblem ??= "A terminal tmux client has malformed visible-pane state.";
      return [];
    }
    if (
      visible.some(
        (candidate) =>
          !panePlacements.some(
            (placement) => placement.id === candidate.id && matchesPlacement(placement),
          ),
      )
    ) {
      inputProblem ??=
        "A terminal tmux client's visible panes disagree with its session or window placement.";
      return [];
    }
    if (!visible.some((candidate) => candidate.id === pane.id)) {
      inputProblem ??= "A terminal tmux client's active pane is absent from its visible window.";
      return [];
    }
    return visible.map((candidate) => candidate.id);
  });

  let sameServer = false;
  if (caller.status === "attached" && caller.socketPath !== observed.socketPath) {
    // A complete context for another socket is valid, but it does not select
    // this server and grants no force exception here.
  } else if (caller.status === "attached") {
    const paneMatchesSession = panePlacements.some(
      (candidate) =>
        candidate.id === caller.paneId && candidate.format.session_id === caller.sessionId,
    );
    const sessionExists = snapshot.sessions
      .toArray()
      .some((session) => session.id === caller.sessionId);
    if (caller.serverPid !== observed.pid || !paneMatchesSession || !sessionExists) {
      inputProblem ??=
        "The caller's tmux pane, session, or daemon generation is no longer current.";
    } else {
      sameServer = true;
    }
  }

  return {
    attendedPaneIds: [...new Set(attended)],
    callerPaneId: caller.paneId,
    callerPaneIsOnThisServer: sameServer,
    clients,
    ...(inputProblem === undefined ? {} : { inputProblem }),
    serverPid: observed.pid,
    serverSocketPath: observed.socketPath,
    serverStartTime: observed.startTime,
  };
}

/** Whether writing to `paneId` would type into this process's own terminal. */
export function isCallerPane(identity: CallerIdentity, paneId: string): boolean {
  return identity.callerPaneIsOnThisServer && identity.callerPaneId === paneId;
}

/** Whether a person is currently looking at `paneId`. */
export function isAttended(identity: CallerIdentity, paneId: string): boolean {
  return identity.attendedPaneIds.includes(paneId);
}
