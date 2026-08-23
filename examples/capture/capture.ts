import type { Server } from "libtmux";

/**
 * Move text through a tmux buffer, and read what a pane is showing.
 *
 * The half of orchestration that is not making things happen. A named buffer
 * is tmux's own clipboard: anything in it can be pasted into any pane on the
 * server, by this process or by a person at the keyboard, without the text
 * passing through your program a second time.
 */
export async function moveTextThroughABuffer(
  server: Server,
  text: string,
): Promise<{ named: readonly string[]; roundTripped: readonly string[] }> {
  // tmux stores nothing for empty text and reports success, so a buffer whose
  // content is computed has to be checked before it is written — otherwise the
  // name is absent and the next call to read it is what fails.
  if (text === "") throw new Error("tmux holds no empty buffer");

  await server.setBuffer("report", text);
  const roundTripped = await server.showBuffer("report");
  const named = await server.listBuffers();

  // Buffers outlive the program that made them.
  await server.deleteBuffer("report");
  return { named, roundTripped };
}

/**
 * What a pane is showing, scrollback included.
 *
 * `start` counts back from the visible top, so -100 asks for the last hundred
 * lines or as many as exist. A pane that has printed nothing answers with
 * nothing rather than with blank lines.
 */
export async function readPane(server: Server): Promise<readonly string[]> {
  const session = await server.newSession({ name: "capture" });
  const pane = session.activePane;
  if (pane === undefined) throw new Error("a new session always has one pane");
  return pane.capture({ start: -100 });
}
