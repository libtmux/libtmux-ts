import {
  killProgram,
  programOutput,
  streamProgram,
  waitProgram,
} from "./_internal/operations/program.js";
import type { Pane } from "./pane.js";
import type { ProgramExit, ProgramWaitOptions } from "./types.js";

/**
 * A program started by {@link Server.spawn}, running in a session of its own.
 *
 * Nothing was typed to start it, so its pane holds only what it printed. The
 * pane is a real terminal: drive a full-screen program with
 * {@link Pane.sendKeys} and read its screen with {@link Pane.capture}.
 *
 * It owns its session. {@link Program.kill}, or leaving an `await using`
 * scope, ends the program and removes the session; a program left running
 * keeps both, also after this process exits. A kill ends a stream in progress
 * with {@link LibTmuxError}, and a pane removed from outside with
 * {@link ObjectNotFoundError}. After `kill`, `output` raises
 * {@link ObjectNotFoundError}, `stream` raises {@link LibTmuxError}, and
 * `wait` returns the exit it already saw or raises {@link ObjectNotFoundError}.
 *
 * Requires tmux 3.8 or newer.
 */
export class Program implements AsyncDisposable {
  declare private readonly programBrand: undefined;
  /**
   * The pane the program runs in.
   *
   * ```ts
   * await using program = await server.spawn(["cat"]);
   * await program.pane.sendKeys("hello");
   * ```
   */
  declare readonly pane: Pane;

  /**
   * The session the program runs in: a detached one of its own, removed with
   * it, or with `from` that pane's session, which loses only the program's
   * window. `tmux attach -t` it to watch the program.
   *
   * ```ts
   * await using program = await server.spawn(["sleep", "1"]);
   * program.sessionName.startsWith("libtmux-program-"); // true
   * ```
   */
  declare readonly sessionName: string;

  private constructor() {
    throw new Error("Program cannot be constructed directly; use Server.spawn");
  }

  /**
   * Resolve with how the program ended, once it has.
   *
   * Giving up leaves the program running: a timeout throws
   * {@link WaitTimeoutError} and an abort throws {@link TmuxTransportError}
   * of kind `cancelled`. A program whose pane is killed from outside raises
   * {@link ObjectNotFoundError} in about a second.
   *
   * ```ts
   * await using program = await server.spawn(["sh", "-c", "exit 3"]);
   * (await program.wait()).exitCode; // 3
   * ```
   */
  wait(options?: ProgramWaitOptions): Promise<ProgramExit> {
    return waitProgram(this, options);
  }

  /**
   * What the program has printed so far, as its terminal shows it.
   *
   * Scrollback is included and wrapped lines are joined. Tabs and trailing
   * spaces are kept; colors and cursor movement are applied rather than
   * returned.
   *
   * ```ts
   * await using program = await server.spawn(["echo", "hello"]);
   * await program.wait();
   * await program.output(); // "hello"
   * ```
   */
  async output(): Promise<string> {
    return (await programOutput(this)).text;
  }

  /**
   * Everything the program writes, as UTF-8 text in the order it was written,
   * until it exits and its last write has arrived.
   *
   * Needs `stream: true` at spawn. The text is the terminal's: line ends are
   * `\r\n`, escape sequences are left in, and bytes that are not UTF-8 become
   * U+FFFD. Each call reads from the start; leaving the loop early stops it.
   *
   * ```ts
   * await using program = await server.spawn(["seq", "1", "3"], { stream: true });
   * let text = "";
   * for await (const chunk of program.stream()) text += chunk;
   * text; // "1\r\n2\r\n3\r\n"
   * ```
   */
  stream(): AsyncGenerator<string, void, undefined> {
    return streamProgram(this);
  }

  /**
   * End the program and remove its session; every call waits for the same end.
   *
   * A running program gets SIGTERM and, two seconds later, SIGKILL, sent to
   * its process group on the tmux server's machine, so one that ignores
   * SIGHUP still ends.
   *
   * ```ts
   * const program = await server.spawn(["sleep", "30"]);
   * await program.kill();
   * ```
   */
  kill(): Promise<void> {
    return killProgram(this);
  }

  /**
   * Kill the program when an `await using` scope ends.
   *
   * ```ts
   * let name = "";
   * {
   *   await using program = await server.spawn(["sleep", "30"]);
   *   name = program.sessionName;
   * }
   * await server.hasSession(name); // false
   * ```
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.kill();
  }
}
