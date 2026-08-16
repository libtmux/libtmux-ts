import type { ServerSnapshot } from "../../types.js";
import type { Server } from "../../server.js";
import type { NormalizedGraph } from "../graph/model.js";
import type { RuntimeContext } from "../runtime/context.js";
import { acquireServerGraph } from "./acquire.js";
import { selectionOfModel } from "./projections.js";

/**
 * Build every selection from a graph the caller already acquired.
 *
 * Each model needs its own projection because a projection's members come from
 * a single listing, but all four share the graph that acquisition produced, so
 * the whole snapshot still costs one round of tmux commands. Split from
 * {@link buildServerSnapshot} so refreshing a handle can reach the same
 * selections rather than a second, differently-built set of them.
 */
export async function buildSnapshotFromGraph(
  server: Server,
  graph: NormalizedGraph,
): Promise<ServerSnapshot> {
  const [sessions, windows, panes, clients] = await Promise.all([
    selectionOfModel(server, graph, "session"),
    selectionOfModel(server, graph, "window"),
    selectionOfModel(server, graph, "pane"),
    selectionOfModel(server, graph, "client"),
  ]);

  return Object.freeze({ clients, panes, sessions, windows });
}

/** Acquire the server and build every selection from that one instant. */
export async function buildServerSnapshot(
  server: Server,
  runtime: RuntimeContext,
): Promise<ServerSnapshot> {
  return buildSnapshotFromGraph(server, await acquireServerGraph(runtime));
}
