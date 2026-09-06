import type { Server } from "libtmux/server";

/**
 * Drive tmux the way an agent does: act, then wait for the result.
 *
 * `Pane.run` subscribes, sends, and matches `until` only after the shell's
 * echo of the keys. Completing on that echo is refused.
 */
export async function runAndWait(
  server: Server,
  command: string,
  marker: string,
  options?: { readonly timeoutMs?: number },
): Promise<string> {
  const session = await server.newSession({ name: "agent" });
  const pane = session.activePane;
  if (pane === undefined) throw new Error("a new session always has one pane");
  const output = await pane.run(command, {
    until: marker,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return output;
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
