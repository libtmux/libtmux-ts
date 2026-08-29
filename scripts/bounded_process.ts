interface BoundedCommandOptions {
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly timeoutMilliseconds: number;
}

export interface BoundedCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

const TERMINATION_GRACE_MILLISECONDS = 5_000;

function capturePipe(stream: ReadableStream<Uint8Array>): {
  cancel(): void;
  readonly text: Promise<string>;
} {
  const reader = stream.getReader();
  const text = (async () => {
    const decoder = new TextDecoder();
    const output: string[] = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- each read advances one pipe cursor.
      const { done, value } = await reader.read();
      if (done) return `${output.join("")}${decoder.decode()}`;
      output.push(decoder.decode(value, { stream: true }));
    }
  })();
  return {
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
    text,
  };
}

export async function runBoundedCommand(
  command: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const child = Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: process.platform !== "win32",
    env: options.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = capturePipe(child.stdout);
  const stderr = capturePipe(child.stderr);
  let timedOut = false;

  const signalTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          child.kill(signal);
          return;
        }
      }
    }
    child.kill(signal);
  };
  const cancelPipes = (): void => {
    stdout.cancel();
    stderr.cancel();
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    signalTree("SIGTERM");
    cancelPipes();
  }, options.timeoutMilliseconds);
  const hardDeadline = setTimeout(() => {
    signalTree("SIGKILL");
    cancelPipes();
  }, options.timeoutMilliseconds + TERMINATION_GRACE_MILLISECONDS);
  deadline.unref?.();
  hardDeadline.unref?.();

  try {
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      child.exited,
      stdout.text,
      stderr.text,
    ]);
    return { exitCode, stderr: stderrText, stdout: stdoutText, timedOut };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardDeadline);
    if (timedOut) signalTree("SIGKILL");
  }
}
