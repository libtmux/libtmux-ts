import type { RawCompleteFormatRow } from "../codec/schemas.js";
import { LibTmuxException } from "../../exc.js";
import type { AbortLike } from "../../types.js";
import { executeGuardedListGroup, type GuardedListing } from "../codec/guarded_listing.js";
import { FormatProtocolError } from "../codec/guard_codec.js";
import { createGraphSourceId, type CapturedRowSet, type NormalizedGraph } from "../graph/model.js";
import { normalizeGraph } from "../graph/normalize.js";
import {
  beginDaemonObservation,
  observeDaemonIdentity,
  type DaemonIdentity,
  type RuntimeContext,
} from "../runtime/context.js";

const MAX_ACQUISITION_ATTEMPTS = 2;

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
 * The leading identity frame always carries `pid` and `start_time`. Every
 * listing row repeats those universal-scope fields so acquisition can reject a
 * row from another daemon rather than joining two generations.
 */
type DaemonRow = Readonly<Pick<RawCompleteFormatRow, "pid" | "start_time">>;

export function daemonIdentityOf(
  identity: DaemonRow,
  rows: readonly (readonly DaemonRow[])[],
): DaemonIdentity {
  if (identity.pid == null || identity.start_time == null) {
    throw new FormatProtocolError("identity frame has an incomplete daemon identity");
  }
  const daemon: DaemonIdentity = Object.freeze({
    pid: identity.pid,
    startTime: identity.start_time,
  });
  for (const set of rows) {
    for (const row of set) {
      if (row.pid == null || row.start_time == null) {
        throw new FormatProtocolError("captured row has an incomplete daemon identity");
      }
      if (daemon.pid !== row.pid || daemon.startTime !== row.start_time) {
        throw new FormatProtocolError("captured row disagrees with the daemon identity frame");
      }
    }
  }
  return daemon;
}

/**
 * Acquire the server's complete object graph.
 *
 * Every `list-*` row becomes exactly one record whose model the subcommand
 * fixes, so a pane row registers its session and window entities but is not a
 * session or window record. Each model therefore needs its own listing to
 * supply the contextual rows a selection draws its members from.
 *
 * The daemon identity read and four listings go as one tmux command list,
 * which is what makes them one instant rather than adjacent observations —
 * tmux drains a client's queue whole, so no other client runs in between.
 * Their count does not vary with the topology, which is what lets relation
 * traversal stay free of I/O. Listing windows and panes with `-a` keeps that
 * true across every session, and both placements of a window linked into two
 * sessions survive as two window records sharing one window entity.
 */
async function acquireServerGraphAttempt(
  runtime: RuntimeContext,
  attemptsRemaining: number,
  signal?: AbortLike,
): Promise<NormalizedGraph> {
  const observation = beginDaemonObservation(runtime);
  const capabilities = await runtime.capabilities.bind(signal);
  const grouped = await executeGuardedListGroup({
    capabilities: runtime.capabilities,
    connection: runtime.connection,
    listings: ACQUISITION_LISTINGS,
    ...(signal === undefined ? {} : { signal }),
    ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
    transport: runtime.transport,
  });
  const [sessions = [], windows = [], panes = [], clients = []] = grouped.listings;

  const daemon = daemonIdentityOf(grouped.daemon, [sessions, windows, panes, clients]);
  if (!observeDaemonIdentity(runtime, observation, capabilities, daemon)) {
    if (attemptsRemaining > 1) {
      return acquireServerGraphAttempt(runtime, attemptsRemaining - 1, signal);
    }
    throw new LibTmuxException("daemon changed repeatedly during graph acquisition");
  }

  return normalizeGraph({
    capture: {
      capabilityFingerprint: capabilities.fingerprint,
      connection: capabilities.connectionAlias,
      daemon,
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

export function acquireServerGraph(
  runtime: RuntimeContext,
  signal?: AbortLike,
): Promise<NormalizedGraph> {
  return acquireServerGraphAttempt(runtime, MAX_ACQUISITION_ATTEMPTS, signal);
}
