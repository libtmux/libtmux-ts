import type { Subprocess } from "bun";

export type PtyOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number | undefined;
  rows?: number | undefined;
  /** SIGTERM the command when this aborts. */
  signal?: AbortSignal;
  /** Milliseconds after which the command and its process group are killed. */
  deadline?: number;
};
export type PtyResult = { code: number; stdout: string };

/** A command on a pseudo-terminal that Bun allocates, so it has a controlling terminal. */
export type Pty = {
  pid: number;
  /** Everything the command has written to the terminal so far. */
  output(): string;
  /** Types text at the command. */
  write(text: string): void;
  /** Kills the command and everything it started. */
  kill(): void;
  /** Resolves once the command has exited and the terminal has delivered its last byte. */
  result: Promise<PtyResult>;
};

export function startPty(argv: string[], options: PtyOptions): Pty {
  const decoder = new TextDecoder();
  const closed = Promise.withResolvers<void>();
  let output = "";
  const child: Subprocess = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      data(_terminal, bytes) {
        output += decoder.decode(bytes, { stream: true });
      },
      exit() {
        closed.resolve();
      },
    },
  });
  // The command leads its own session, so its group holds everything it started.
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const timer =
    options.deadline === undefined ? undefined : setTimeout(killGroup, options.deadline);
  const interrupt = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", interrupt, { once: true });
  const result = (async () => {
    const code = await child.exited;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", interrupt);
    // A survivor would hold the terminal open and keep it from reporting its end.
    killGroup();
    await closed.promise;
    child.terminal?.close();
    return { code, stdout: output + decoder.decode() };
  })();
  return {
    pid: child.pid,
    output: () => output,
    write: (text) => void child.terminal?.write(text),
    kill: killGroup,
    result,
  };
}

/** Runs a command to its end on a pseudo-terminal and returns what it wrote there. */
export const runInPty = (argv: string[], options: PtyOptions): Promise<PtyResult> =>
  startPty(argv, options).result;
