import type { EventEmitter } from "node:events";

interface BoundedCommandOptions {
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly maxOutputBytes: number;
  readonly stdin?: string;
  readonly timeoutMilliseconds: number;
}

export type BoundedCommandTermination =
  | "exited"
  | "output_limit_exceeded"
  | "signaled"
  | "timed_out";

export interface BoundedCommandResult {
  readonly exitCode: number;
  readonly signalCode: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly termination: BoundedCommandTermination;
}

const TERMINATION_GRACE_MILLISECONDS = 5_000;
const ownedProcessGroups = new Set<() => void>();
type ParentSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

const signalExitCodes: Readonly<Record<ParentSignal, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const processEvents: Pick<EventEmitter, "listeners" | "removeListener"> = process;

function removeParentSignalHandlers(): void {
  processEvents.removeListener("SIGHUP", relaySighup);
  processEvents.removeListener("SIGINT", relaySigint);
  processEvents.removeListener("SIGTERM", relaySigterm);
}

function relayParentSignal(signal: ParentSignal, listener: () => void): void {
  const hostOwnsSignal = processEvents
    .listeners(signal)
    .some((candidate) => candidate !== listener);
  for (const reap of ownedProcessGroups) {
    try {
      reap();
    } catch {
      // The process is terminating; best-effort cleanup must not mask its signal.
    }
  }
  if (hostOwnsSignal) return;
  removeParentSignalHandlers();
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(signalExitCodes[signal]);
  }
}

function relaySighup(): void {
  relayParentSignal("SIGHUP", relaySighup);
}

function relaySigint(): void {
  relayParentSignal("SIGINT", relaySigint);
}

function relaySigterm(): void {
  relayParentSignal("SIGTERM", relaySigterm);
}

function registerProcessGroup(reap: () => void): () => void {
  if (ownedProcessGroups.size === 0) {
    process.prependListener("SIGHUP", relaySighup);
    process.prependListener("SIGINT", relaySigint);
    process.prependListener("SIGTERM", relaySigterm);
  }
  ownedProcessGroups.add(reap);
  return () => {
    ownedProcessGroups.delete(reap);
    if (ownedProcessGroups.size === 0) removeParentSignalHandlers();
  };
}

function capturePipe(
  stream: ReadableStream<Uint8Array>,
  retain: (value: Uint8Array) => Uint8Array,
  outputLimitExceeded: () => void,
): {
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
      const retained = retain(value);
      if (retained.byteLength > 0) output.push(decoder.decode(retained, { stream: true }));
      if (retained.byteLength < value.byteLength) {
        outputLimitExceeded();
        return `${output.join("")}${decoder.decode()}`;
      }
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
  if (command.length === 0) throw new Error("bounded command cannot be empty");
  if (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1) {
    throw new Error("bounded command timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new Error("bounded command output limit must be a positive integer");
  }
  let reapOwnedProcessGroup = (): void => undefined;
  const unregisterProcessGroup = registerProcessGroup(() => reapOwnedProcessGroup());
  const child = (() => {
    try {
      return Bun.spawn([...command], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        detached: process.platform !== "win32",
        env: options.env,
        stderr: "pipe",
        stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
        stdout: "pipe",
      });
    } catch (error) {
      unregisterProcessGroup();
      throw error;
    }
  })();

  let remainingOutputBytes = options.maxOutputBytes;
  const retain = (value: Uint8Array): Uint8Array => {
    const retainedBytes = Math.min(remainingOutputBytes, value.byteLength);
    remainingOutputBytes -= retainedBytes;
    return retainedBytes === value.byteLength ? value : value.subarray(0, retainedBytes);
  };
  let forcedTermination: "output_limit_exceeded" | "timed_out" | undefined;
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  let stdout: ReturnType<typeof capturePipe> | undefined;
  let stderr: ReturnType<typeof capturePipe> | undefined;

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
    stdout?.cancel();
    stderr?.cancel();
  };
  reapOwnedProcessGroup = () => signalTree("SIGKILL");
  const stop = (reason: "output_limit_exceeded" | "timed_out"): void => {
    if (forcedTermination !== undefined) return;
    forcedTermination = reason;
    signalTree("SIGTERM");
    cancelPipes();
    hardDeadline = setTimeout(() => {
      signalTree("SIGKILL");
      cancelPipes();
    }, TERMINATION_GRACE_MILLISECONDS);
    hardDeadline.unref?.();
  };
  stdout = capturePipe(child.stdout, retain, () => stop("output_limit_exceeded"));
  stderr = capturePipe(child.stderr, retain, () => stop("output_limit_exceeded"));
  const deadline = setTimeout(() => stop("timed_out"), options.timeoutMilliseconds);
  deadline.unref?.();

  try {
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      child.exited,
      stdout.text,
      stderr.text,
    ]);
    return {
      exitCode,
      signalCode: child.signalCode,
      stderr: stderrText,
      stdout: stdoutText,
      termination: forcedTermination ?? (child.signalCode === null ? "exited" : "signaled"),
    };
  } finally {
    clearTimeout(deadline);
    if (hardDeadline !== undefined) clearTimeout(hardDeadline);
    signalTree("SIGKILL");
    unregisterProcessGroup();
  }
}
