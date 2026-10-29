import type { Pane } from "libtmux";
import type { Server } from "libtmux/server";

/**
 * Drive tmux the way an agent does: act, then wait for the result.
 *
 * One control observer carries notifications while commands use the server's
 * engine. Keeping the observer open makes event-driven waits persistent; it
 * does not turn command output into a control-mode protocol.
 */
export async function runAndWait(server: Server, command: string, marker: string): Promise<string> {
  // A connection attaches, so the session has to exist first. On a server with
  // none, `connect()` fails saying exactly that.
  const session = await server.newSession({ name: "agent" });

  await using live = await server.connect({ target: session.id });

  const pane = (await live.snapshot()).sessions.one({ id: session.id }).panes.one();

  // Subscribe before acting. A marker printed between the command and the
  // subscription is one nobody is listening for, and the wait never ends.
  const printed = live
    .subscribe()
    .find(
      (event) => event.kind === "output" && event.paneId === pane.id && event.data.includes(marker),
      { timeoutMs: 30_000 },
    );

  await pane.sendKeys(command);

  const event = await printed;
  if (event === undefined) throw new Error(`${command} never printed ${marker}`);
  return event.kind === "output" ? event.data : "";
}

/**
 * Wait for the server to reach a shape, rather than for one event.
 *
 * `waitFor` reads the server, then re-reads on each notification, so it returns
 * at once when the condition already holds and does not miss a change that
 * lands while it is subscribing.
 */
export async function buildAndSettle(server: Server, windows: readonly string[]): Promise<number> {
  const session = await server.newSession({ name: "settling" });
  await using live = await server.connect({ target: session.id });

  const bound = (await live.snapshot()).sessions.one({ id: session.id });
  for (const name of windows) {
    // eslint-disable-next-line no-await-in-loop -- window order is observable.
    await bound.newWindow({ name });
  }

  const settled = await live.waitFor(
    (snapshot) => windows.every((name) => snapshot.windows.exists({ name })),
    { timeoutMs: 30_000 },
  );

  return settled.windows.count({ session: { is: { id: session.id } } });
}

/**
 * Run a command in a shell that marks its commands, and learn whether it worked.
 *
 * A shell whose prompt writes an OSC 133 `D` mark with the last status tells
 * tmux when each command ends and how; no marker has to be printed or read
 * back. `send` types the command once the wait is listening.
 */
export async function runMarked(pane: Pane, command: string): Promise<boolean> {
  const status = await pane.waitForCommand({ send: command, timeoutMs: 30_000 });
  return status === 0;
}

/**
 * Wait for a pane's program to exit, whoever started it.
 *
 * A pane that closes on exit takes its status with it, and tmux reports that
 * status in the same event, so it is not lost.
 */
export async function waitForExit(pane: Pane): Promise<number | null> {
  const { exitCode } = await pane.waitForExit({ timeoutMs: 30_000 });
  return exitCode;
}
