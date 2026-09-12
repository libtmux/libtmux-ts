import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type ProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  terminal?: boolean;
  output?: (stream: "stdout" | "stderr", text: string) => Promise<void>;
};
export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
};
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
  const grouped = process.platform !== "win32";
  const terminal = options.terminal ? await open("/dev/tty", "r+") : undefined;
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: terminal ? [terminal.fd, terminal.fd, terminal.fd] : ["ignore", "pipe", "pipe"],
      detached: grouped && !terminal,
    });
  } catch (error) {
    await terminal?.close();
    throw error;
  }
  let failure: unknown;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let escalationDone: Promise<void> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (grouped && !terminal && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
    }
  };
  const stop = () => {
    if (escalationDone) return;
    kill("SIGTERM");
    escalationDone = new Promise((resolve) => {
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
    child.once("close", (code, signal) =>
      resolve(options.signal?.aborted ? 130 : (code ?? (signal ? 1 : 0))),
    );
  });
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
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
      failure ??= error;
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
    await terminal?.close();
  }
}
