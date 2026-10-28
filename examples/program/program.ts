import { TmuxTransportError } from "libtmux";
import type { DeliveryStatus, Pane, Program, ProgramResult, Server } from "libtmux";

/**
 * Run a program and keep only what it printed.
 *
 * `argv` reaches the program unexpanded. `timedOut` is a
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
 * removes its pane however the function leaves.
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
 * text is the terminal's: `\r\n` line ends, escape sequences left in. The copy
 * stops at a mebibyte, and the stream then throws after what it kept.
 */
export async function followOutput(
  server: Server,
  argv: readonly string[],
  onChunk: (chunk: string) => void,
): Promise<number | null> {
  await using program = await server.spawn(argv, { maxStreamBytes: 1_048_576, stream: true });
  for await (const chunk of program.stream()) onChunk(chunk);
  return (await program.wait()).exitCode;
}

/**
 * Give a program a stdin.
 *
 * The input is written to a private file the program reads, so it passes
 * through no shell quoting, and the terminal stays the program's output.
 */
export async function sortLines(server: Server, input: string): Promise<readonly string[]> {
  const result = await server.run(["sort"], { input });
  if (!result.success) throw new Error(`sort exited ${String(result.exitCode)}: ${result.output}`);
  return result.output === "" ? [] : result.output.split("\n");
}

/**
 * Run a program unless `signal` fires first, and say how far a cancelled one got.
 *
 * The abort ends the program and removes its pane. `delivery` is `not_started`
 * when nothing ran and `written` when the program had started, so its work may
 * be half done.
 */
export async function runUnlessCancelled(
  server: Server,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<ProgramResult | { readonly cancelled: DeliveryStatus }> {
  const outcome = await server.run(argv, { signal }).catch((error: unknown) => {
    if (!(error instanceof TmuxTransportError) || error.kind !== "cancelled") throw error;
    return { cancelled: error.delivery };
  });
  return outcome;
}

/**
 * Run a program beside a person's pane and leave its output there for them.
 *
 * The split leaves focus where it was, and `keep` leaves the pane once the
 * program has ended, for the person to read and close.
 */
export async function runBeside(
  server: Server,
  pane: Pane,
  argv: readonly string[],
): Promise<boolean> {
  const result = await server.run(argv, { from: pane, keep: true, placement: "split" });
  return result.success;
}

/**
 * Start a service that ends with this process, and return once it says it is ready.
 *
 * This process renews a lease on it. Should it exit or die without killing
 * the service, tmux ends it and removes its pane within ten seconds.
 */
export async function startService(
  server: Server,
  argv: readonly string[],
  ready: string,
): Promise<Program> {
  const service = await server.spawn(argv, { orphanAfterMs: 10_000, stream: true });
  try {
    let printed = "";
    for await (const chunk of service.stream()) {
      printed += chunk;
      if (printed.includes(ready)) return service;
    }
  } catch (error) {
    await service.kill();
    throw error;
  }
  await service.kill();
  throw new Error(`${argv.join(" ")} exited before printing ${ready}`);
}
