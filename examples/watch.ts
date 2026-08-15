import type { Server } from "libtmux/server";
import type { TmuxEvent } from "libtmux";

/**
 * React to tmux as it changes, rather than polling for what changed.
 *
 * `watch()` holds one control-mode connection open and yields notifications as
 * they happen. The stream is an async disposable, so `await using` closes it on
 * the way out of the scope — including when the loop throws.
 */
export async function watchUntilWindowOpens(server: Server): Promise<TmuxEvent> {
  const session = await server.newSession({ name: "watched" });

  // A control client is told about the session it attached to, so watch the
  // one you intend to change. Target by id: a session always has one, and it
  // cannot be ambiguous the way a name can.
  await using events = server.watch({ target: session.id });

  // A control client is told nothing that happened before it attached, so the
  // change has to wait for the attach rather than for the call that started it.
  await events.ready();

  const opened = session.newWindow({ name: "second" });
  const event = await events.find((candidate) => candidate.kind === "window-add");
  await opened;

  if (event === undefined) throw new Error("the stream ended before a window opened");
  return event;
}

/**
 * Follow one pane's output.
 *
 * tmux sends a control client no pane output until it attaches, which `watch()`
 * does for you. Payload bytes arrive unescaped and decoded, so multi-byte text
 * survives intact.
 */
export async function collectPaneOutput(server: Server, until: string): Promise<string> {
  await using events = server.watch();
  let collected = "";

  for await (const event of events) {
    if (event.kind !== "output") continue;
    collected += event.data;
    if (collected.includes(until)) return collected;
  }

  return collected;
}
