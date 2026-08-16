import type { Client } from "../../client.js";
import { LibTmuxException } from "../../exc.js";
import type { Pane } from "../../pane.js";
import type { Session } from "../../session.js";
import type { ServerSnapshot } from "../../types.js";
import type { Window } from "../../window.js";
import type { RuntimeContext } from "../runtime/context.js";
import {
  entityRefForHandle,
  snapshotForHandle,
  winlinkRefForHandle,
} from "../runtime/live_handle.js";
import type { WinlinkRef } from "../graph/refs.js";
import { acquireServerGraph } from "./acquire.js";
import { buildSnapshotFromGraph } from "./snapshot.js";

type Child = Client | Pane | Session | Window;

/**
 * Whether two handles describe the same window placement.
 *
 * A session can link one window at more than one index at the same time, so a
 * placement is identified by all three parts rather than by its window: after
 * `link-window -s a:1 -t a:9`, `@1` genuinely sits at both `a:1` and `a:9`, and
 * matching on the window alone would pick whichever tmux listed first.
 */
function sameWinlink(left: WinlinkRef | null, right: WinlinkRef | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.sessionId === right.sessionId &&
    left.windowId === right.windowId &&
    left.windowIndex === right.windowIndex
  );
}

function candidatesFor(snapshot: ServerSnapshot, handle: Child): readonly Child[] {
  const entity = entityRefForHandle(handle);
  switch (entity.kind) {
    case "pane":
      return snapshot.panes.toArray();
    case "session":
      return snapshot.sessions.toArray();
    case "window":
      return snapshot.windows.toArray();
    case "client":
      return snapshot.clients.toArray();
  }
}

/**
 * Whether two handles are two readings of one thing.
 *
 * The deliberate opposite of `liveHandlesEqual`, which asks whether two handles
 * are interchangeable. Both are correct, and they disagree about clients on
 * purpose:
 *
 * | | `liveHandlesEqual` | `isSameSubject` |
 * | --- | --- | --- |
 * | pane, window, session | server, kind, id | connection, epoch, kind, id |
 * | client | every field of the row | `client_name` alone |
 *
 * `equals` compares two values a caller holds, so a client read at two instants
 * is two things. This asks whether a later snapshot holds the same subject, so
 * a client must stay recognisable however much of it changed. Merging them
 * breaks one caller or the other.
 */
function isSameSubject(left: Child, right: Child): boolean {
  const a = entityRefForHandle(left);
  const b = entityRefForHandle(right);
  if (a.kind === "client" || b.kind === "client") {
    // tmux identifies a client by the terminal it occupies; every other field
    // is state that a re-read is expected to change.
    return snapshotForHandle(left).client_name === snapshotForHandle(right).client_name;
  }
  return a.connection === b.connection && a.epoch === b.epoch && a.kind === b.kind && a.id === b.id;
}

/**
 * Read this handle again, at a new instant, as a new handle.
 *
 * The receiver is not touched. A handle and the snapshot that produced it are
 * one immutable reading of the server, and advancing a handle inside a frozen
 * selection would leave that selection's criteria matching on rows its own
 * members no longer agree with — `where({name: "old"})` returning an object
 * whose `name` is `"new"`. Returning the later handle keeps both readings
 * internally consistent, and the caller decides which one it wants.
 *
 * The result comes from a full snapshot, so its relations are the same objects
 * that snapshot would hand out rather than a second materialization of them.
 */
export async function refreshedHandle<Handle extends Child>(
  handle: Handle,
  runtime: RuntimeContext,
): Promise<Handle> {
  const graph = await acquireServerGraph(runtime);
  const snapshot = await buildSnapshotFromGraph(handle.server, graph);
  const winlink = winlinkRefForHandle(handle);
  const found = candidatesFor(snapshot, handle).find(
    (candidate) =>
      isSameSubject(candidate, handle) && sameWinlink(winlinkRefForHandle(candidate), winlink),
  );
  if (found === undefined) {
    throw new LibTmuxException(`${handle.toString()} no longer exists on the server`);
  }
  return found as Handle;
}
