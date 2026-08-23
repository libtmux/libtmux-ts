import type { CompleteFormatRow } from "../codec/schemas.js";
import { executeGuardedListGroup, type GuardedListing } from "../codec/guard_codec.js";
import { createGraphSourceId, type CapturedRowSet, type NormalizedGraph } from "../graph/model.js";
import { normalizeGraph } from "../graph/normalize.js";
import {
  observeDaemonIdentity,
  type DaemonIdentity,
  type RuntimeContext,
} from "../runtime/context.js";

/**
 * The four listings one acquisition runs, in the order their sections arrive.
 *
 * Named rather than inlined because the argv budget test measures this exact
 * list: tmux packs a command's argv into 16KB, and four guarded formats are
 * most of it.
 */
export const ACQUISITION_LISTINGS: readonly GuardedListing[] = Object.freeze([
  Object.freeze({ listCommand: "list-sessions" as const }),
  Object.freeze({ listCommand: "list-windows" as const, listExtraArgs: Object.freeze(["-a"]) }),
  Object.freeze({ listCommand: "list-panes" as const, listExtraArgs: Object.freeze(["-a"]) }),
  Object.freeze({ listCommand: "list-clients" as const }),
]);

/**
 * Which daemon answered this listing.
 *
 * `pid` and `start_time` are universal-scope fields, so every row of every
 * listing already carries them and reading the daemon's identity costs no
 * command of its own. A server with nothing on it lists no rows at all, and
 * then there is nothing to compare — which is correct: an empty server has
 * handed out no handles to invalidate.
 */
function daemonOf(rows: readonly (readonly CompleteFormatRow[])[]): DaemonIdentity | undefined {
  for (const set of rows) {
    const row = set[0];
    if (row?.pid == null || row.start_time == null) continue;
    return Object.freeze({ pid: row.pid, startTime: row.start_time });
  }
  return undefined;
}

/**
 * Acquire the server's complete object graph.
 *
 * Every `list-*` row becomes exactly one record whose model the subcommand
 * fixes, so a pane row registers its session and window entities but is not a
 * session or window record. Each model therefore needs its own listing to
 * supply the contextual rows a selection draws its members from.
 *
 * The four listings go as one tmux command list, which is what makes them one
 * instant rather than four adjacent ones — tmux drains a client's queue whole,
 * so no other client runs in between. Their count does not vary with the
 * topology, which is what lets relation traversal stay free of I/O. Listing
 * windows and panes with `-a` keeps that true across every session, and both
 * placements of a window linked into two sessions survive as two window
 * records sharing one window entity.
 */
export async function acquireServerGraph(
  runtime: RuntimeContext,
  // Set only by the retry below. A restart invalidates the epoch that this
  // acquisition already read, so the rows in hand describe the new daemon under
  // the old epoch and cannot be normalized. Reading again under the new one is
  // the whole recovery, and a second restart in that window is a different
  // outage rather than a reason to keep going round.
  afterRestart = false,
): Promise<NormalizedGraph> {
  const [capabilities, [sessions = [], windows = [], panes = [], clients = []]] = await Promise.all(
    [
      runtime.capabilities.bind(),
      executeGuardedListGroup({
        capabilities: runtime.capabilities,
        connection: runtime.connection,
        listings: ACQUISITION_LISTINGS,
        ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
        transport: runtime.transport,
      }),
    ],
  );

  // A restart hands the next daemon the same socket and the same ids, so
  // noticing it here is what keeps a handle from the previous one from
  // resolving against its successor. Invalidating the epoch is what enforces
  // that: every graph captured under the old epoch stops validating.
  const daemon = daemonOf([sessions, windows, panes, clients]);
  if (daemon !== undefined && observeDaemonIdentity(runtime, daemon).restarted && !afterRestart) {
    return acquireServerGraph(runtime, true);
  }

  return normalizeGraph({
    capture: {
      capabilityFingerprint: capabilities.fingerprint,
      connection: capabilities.connectionAlias,
      ...(daemon === undefined ? {} : { daemon }),
      epoch: capabilities.daemonEpoch,
      tmuxVersion: capabilities.rawVersion,
    },
    sources: [
      { listCommand: "list-sessions", rows: sessions, source: createGraphSourceId("sessions") },
      { listCommand: "list-windows", rows: windows, source: createGraphSourceId("windows") },
      { listCommand: "list-panes", rows: panes, source: createGraphSourceId("panes") },
      { listCommand: "list-clients", rows: clients, source: createGraphSourceId("clients") },
    ] satisfies readonly CapturedRowSet[],
  });
}
