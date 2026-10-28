import type { Server } from "libtmux";

/**
 * Run a program and keep only what it printed.
 *
 * Nothing is typed into a shell, so there is no command line or echo to strip
 * from the output, and `argv` reaches the program unexpanded. `timedOut` is a
 * result rather than an error: the program is ended and what it printed so far
 * still comes back.
 */
export async function listFiles(server: Server, directory: string): Promise<readonly string[]> {
  const result = await server.run(["ls", "-1A", directory], { timeoutMs: 10_000 });
  if (result.timedOut) throw new Error(`ls ${directory} did not finish`);
  if (!result.success) throw new Error(`ls exited ${String(result.exitCode)}: ${result.output}`);
  return result.output === "" ? [] : result.output.split("\n");
}

/**
 * Drive a full-screen program with keys, then wait for it to quit.
 *
 * The program has a real terminal, which is what vim needs. Keys sent at once
 * reach it: `spawn` returns only after the program has started. `await using`
 * removes its session however the function leaves.
 */
export async function prependLine(
  server: Server,
  file: string,
  line: string,
): Promise<number | null> {
  await using vim = await server.spawn(["vim", "-Nu", "NONE", "-i", "NONE", "-n", file]);
  await vim.pane.sendKeys(`ggO${line}`, { enter: false });
  await vim.pane.sendKeys("Escape", { enter: false });
  await vim.pane.sendKeys(":wq");
  const { exitCode } = await vim.wait({ timeoutMs: 10_000 });
  return exitCode;
}

/**
 * Follow a program's output as it is written, its last write included.
 *
 * The stream ends when the program exits and its last write has arrived. Its
 * text is the terminal's: `\r\n` line ends, escape sequences left in.
 */
export async function followOutput(
  server: Server,
  argv: readonly string[],
  onChunk: (chunk: string) => void,
): Promise<number | null> {
  await using program = await server.spawn(argv, { stream: true });
  for await (const chunk of program.stream()) onChunk(chunk);
  return (await program.wait()).exitCode;
}
