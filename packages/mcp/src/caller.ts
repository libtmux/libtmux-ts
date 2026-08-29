/**
 * Where this process is, and where the human is looking.
 *
 * An agent driving tmux has two questions the tmux API does not answer on its
 * own: which pane am I running in, and which panes is somebody watching. The
 * first stops it from typing into its own terminal; the second stops it from
 * typing into someone else's.
 */

import type { ServerSnapshot } from "libtmux";
import type { Server } from "libtmux/server";

/**
 * What tmux exported into the process it started.
 *
 * `TMUX` is `socketPath,serverPid,sessionIndex`. The pane comes from
 * `TMUX_PANE` rather than from that session index: moving a pane between
 * sessions leaves the exported index naming the session it left.
 */
export interface CallerEnvironment {
  readonly paneId: string | undefined;
  readonly serverPid: string | undefined;
  readonly socketPath: string | undefined;
}

/**
 * Read the caller's tmux context out of the environment.
 *
 * Parsed from the right. tmux writes `"%s,%ld,%d"` with the path first, so the
 * last two fields are the pid and the session index however many commas the
 * path holds — and a socket path may hold one. tmux's own reader truncates at
 * the first comma instead, so the path here is ambiguous in exactly the way it
 * is for tmux; the pid, which is what identifies the daemon, is not.
 */
export function readCallerEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CallerEnvironment {
  const raw = environment.TMUX;
  const parts = raw === undefined || raw === "" ? [] : raw.split(",");
  const paneId = environment.TMUX_PANE;
  const serverPid = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  const socketPath = parts.length >= 3 ? parts.slice(0, -2).join(",") : parts[0];
  return {
    paneId: paneId === undefined || paneId === "" ? undefined : paneId,
    serverPid: serverPid === undefined || serverPid === "" ? undefined : serverPid,
    socketPath: socketPath === undefined || socketPath === "" ? undefined : socketPath,
  };
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
   * Compared by daemon pid rather than socket path, because a path names a
   * place and not a process: `kill-server` and a restart put a different daemon
   * at the same path, numbering its panes from `%0` again.
   */
  readonly callerPaneIsOnThisServer: boolean;
  readonly serverPid: string | undefined;
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
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CallerIdentity> {
  const caller = readCallerEnvironment(environment);
  const identity = await tmux.daemonIdentity();
  const clients = snapshot.clients.toArray().map((client): AttachedClient => ({
    activePaneId: client.pane?.id,
    controlMode: client.controlMode ?? false,
    name: client.name ?? "",
    sessionName: client.session?.name ?? undefined,
    tty: client.tty ?? undefined,
  }));

  // A control client is this process and its kin, not a person: counting it as
  // attention would mark every pane the agent watches as one to stay out of.
  const attended = clients
    .filter((client) => !client.controlMode && client.activePaneId !== undefined)
    .map((client) => client.activePaneId ?? "");

  const sameServer =
    caller.paneId !== undefined &&
    identity !== undefined &&
    caller.serverPid !== undefined &&
    caller.serverPid === identity.pid;

  return {
    attendedPaneIds: [...new Set(attended)],
    callerPaneId: caller.paneId,
    callerPaneIsOnThisServer: sameServer,
    clients,
    serverPid: identity?.pid,
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
