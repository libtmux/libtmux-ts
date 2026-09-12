import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { isatty } from "node:tty";

export type ProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  input?: string;
  terminal?: boolean | "input";
  output?: (stream: "stdout" | "stderr", text: string) => Promise<void>;
};
export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
};
export async function openTerminal(
  options: Pick<ProcessOptions, "cwd" | "env" | "signal">,
): Promise<{ fd: number; close(): Promise<void> }> {
  const fd = [0, 1, 2].find(isatty);
  // Bun cannot map fd 0 to child output; tmux rejects the generic /dev/tty name.
  if (fd !== undefined) return open(`/dev/fd/${fd}`, "r+");
  const query = await processRun(["ps", "-p", String(process.pid), "-o", "tty="], {
    cwd: options.cwd,
    env: options.env,
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(1000),
    ]),
  });
  const name = query.stdout.trim();
  if (query.code !== 0 || !/^(?:\/dev\/)?[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(name))
    throw new Error("No controlling terminal");
  return open(name.startsWith("/dev/") ? name : `/dev/${name}`, "r+");
}
export function tokenize(value: string): string[] {
  const args: string[] = [];
  let word = "";
  let quote = "";
  let active = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\" && quote !== "'") {
      const next = value[++index];
      if (next === undefined) throw new Error("Incomplete escape in command");
      if (quote === '"' && !['"', "\\"].includes(next)) word += "\\";
      word += next;
      active = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      active = true;
    } else if (/\s/u.test(character)) {
      if (active) args.push(word);
      word = "";
      active = false;
    } else {
      word += character;
      active = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in command");
  if (active) args.push(word);
  if (!args[0]) throw new Error("Command needs an executable");
  return args;
}

export async function processRun(argv: string[], options: ProcessOptions): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  if (!argv[0]) throw new Error("Command needs an executable");
  if (options.terminal && options.input !== undefined)
    throw new Error("Terminal processes cannot also receive captured input");
  const grouped = process.platform !== "win32";
  const terminal = options.terminal ? await openTerminal(options) : undefined;
  let child;
  try {
    options.signal?.throwIfAborted();
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: terminal
        ? options.terminal === "input"
          ? [terminal.fd, "pipe", "pipe"]
          : [terminal.fd, terminal.fd, terminal.fd]
        : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: grouped && !terminal,
    });
  } catch (error) {
    await terminal?.close();
    throw error;
  }
  let failure: unknown;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let drainDeadline: ReturnType<typeof setTimeout> | undefined;
  let escalationDone: Promise<void> | undefined;
  let finishEscalation: (() => void) | undefined;
  const kill = (signal: NodeJS.Signals | 0): boolean => {
    try {
      if (grouped && !terminal && child.pid !== undefined) {
        process.kill(-child.pid, signal);
        return true;
      }
      return child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      failure ??= error;
      return true;
    }
  };
  const stop = () => {
    if (escalationDone) return;
    if (!kill("SIGTERM")) {
      escalationDone = Promise.resolve();
      return;
    }
    escalationDone = new Promise((resolve) => {
      finishEscalation = resolve;
      escalation = setTimeout(() => {
        kill("SIGKILL");
        resolve();
      }, 500);
    });
  };
  const closed = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(drainDeadline);
      // A reaped leader can leave descendants in its process group.
      if (escalationDone && (!grouped || terminal || !kill(0))) {
        clearTimeout(escalation);
        finishEscalation?.();
      }
      resolve(options.signal?.aborted ? 130 : (code ?? (signal ? 1 : 0)));
    });
  });
  if (!terminal)
    child.once("exit", () => {
      drainDeadline = setTimeout(() => {
        stop();
        void escalationDone?.then(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
      }, 100);
    });
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const input = child.stdin
    ? pipeline(
        Readable.from([options.input!]),
        child.stdin,
        options.signal ? { signal: options.signal } : {},
      ).catch((error: unknown) => {
        if (!options.signal?.aborted) failure ??= error;
        stop();
      })
    : Promise.resolve();
  const drain = async (stream: Readable | null, name: "stdout" | "stderr") => {
    if (!stream) return { text: "", truncated: false };
    const decoder = new StringDecoder("utf8");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let total = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        const retained = buffer.subarray(0, Math.max(0, 65_536 - bytes));
        if (retained.length) chunks.push(Buffer.from(retained));
        bytes += retained.length;
        const text = decoder.write(buffer);
        if (text) await options.output?.(name, text);
      }
      const final = decoder.end();
      if (final) await options.output?.(name, final);
    } catch (error) {
      if (!options.signal?.aborted || error !== options.signal.reason) failure ??= error;
      stop();
      stream.destroy();
    }
    const truncated = total > bytes;
    return {
      text: new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated }),
      truncated,
    };
  };
  try {
    const [code, stdout, stderr] = await Promise.all([
      closed,
      drain(child.stdout, "stdout"),
      drain(child.stderr, "stderr"),
      input,
    ]);
    if (failure) throw failure;
    return {
      code,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await escalationDone;
    clearTimeout(escalation);
    clearTimeout(drainDeadline);
    await terminal?.close();
  }
}
