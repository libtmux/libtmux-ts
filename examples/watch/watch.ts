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

/**
 * Watch a pane without risking the connection when it floods.
 *
 * tmux's remedy for a control client that lets a pane's output back up is to
 * drop the whole connection. `pauseAfterSeconds` asks it to stop that one pane
 * instead: tmux reports `pause`, this connection asks the pane back, and
 * `continue` follows. The pair is a record of what was missed.
 */
export async function watchWithBackpressure(server: Server): Promise<readonly string[]> {
  const session = await server.newSession({ name: "paced" });

  await using events = server.watch({ pauseAfterSeconds: 5, target: session.id });
  await events.ready();

  const pane = (await server.snapshot()).sessions.one({ id: session.id }).panes.one();

  // tmux pauses a pane on its own once it falls behind. Asking for it directly
  // reaches the same state without waiting on a real flood.
  const client = (await server.cmd("list-clients", ["-F", "#{client_name}\t#{client_flags}"]))
    .find((value) => value.includes("control-mode") && value.includes("pause-after=5"))
    ?.split("\t")[0];
  if (client === undefined) throw new Error("the paced observer did not attach");
  await server.cmd("refresh-client", ["-t", client, "-A", `${pane.id}:pause`]);

  const seen: string[] = [];
  for await (const event of events) {
    if (event.kind !== "pause" && event.kind !== "continue") continue;
    seen.push(`${event.kind} ${event.paneId}`);
    if (event.kind === "continue") break;
  }
  return seen;
}

/**
 * Read a pane's output on a connection that has asked tmux to pace it.
 *
 * The pacing is invisible to this loop, which is the point: `pauseAfterSeconds`
 * changes how much tmux will hold, not what a pane's output is called. Matching
 * on `kind === "output"` keeps working, and `age` — the milliseconds tmux held
 * the data before writing it — arrives alongside rather than instead, so a
 * reader can notice it falling behind before tmux pauses the pane.
 */
export async function readOutputUnderBackpressure(
  server: Server,
  marker: string,
): Promise<{ readonly reportedAge: boolean; readonly text: string }> {
  const session = await server.newSession({ name: "paced-output" });

  await using events = server.watch({ pauseAfterSeconds: 5, target: session.id });
  await events.ready();

  const pane = (await server.snapshot()).sessions.one({ id: session.id }).panes.one();

  let text = "";
  let reportedAge = false;
  const printed = (async () => {
    for await (const event of events) {
      if (event.kind !== "output" || event.paneId !== pane.id) continue;
      if (event.age !== undefined) reportedAge = true;
      text += event.data;
      if (text.includes(marker)) return;
    }
  })();

  await pane.sendKeys(`echo ${marker}`);
  await printed;
  await events.close();

  return { reportedAge, text };
}

/**
 * Stop waiting, without the wait becoming a failure.
 *
 * A wait ends three ways and they are not the same answer. Its deadline passing
 * and somebody closing the connection both say the thing did not happen, and
 * answer `undefined`. The connection ending underneath it says nothing about
 * the thing at all, and raises — so a caller never reports "it never printed
 * the marker" about a server that went away.
 */
export async function stopWaiting(server: Server): Promise<{
  readonly onClose: string;
  readonly onDeadline: string;
}> {
  const session = await server.newSession({ name: "cancelled" });

  const live = await server.connect({ target: session.id });
  const deadline = live.subscribe();
  await deadline.ready();
  const onDeadline = await deadline
    .find(() => false, { timeoutMs: 250 })
    .then((event) => (event === undefined ? "undefined" : "matched"));

  const closing = live.subscribe();
  await closing.ready();
  // Settled before anything is awaited: a rejection nobody is holding yet is an
  // unhandled rejection rather than an answer.
  const armed = closing
    .find(() => false, { timeoutMs: 30_000 })
    .then((event) => (event === undefined ? "undefined" : "matched"));
  await live.close();

  return { onClose: await armed, onDeadline };
}
