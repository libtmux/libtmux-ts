import type { Writable } from "node:stream";
import type { OutputMode } from "./parser.ts";

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}
export async function write(stream: Writable, text: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (stream.destroyed || stream.writableEnded)
    throw stream.errored ?? new CliError("output_closed", "Output stream closed");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      stream.off("close", closed);
      signal?.removeEventListener("abort", aborted);
      if (error) {
        setImmediate(() => {
          stream.off("error", failed);
        });
      } else {
        stream.off("error", failed);
      }
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const failed = (error: Error) => {
      finish(error);
    };
    const closed = () => {
      finish(new CliError("output_closed", "Output stream closed before the write completed"));
    };
    const aborted = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      // The caller owns the stream; retain its error guard until the pending write settles.
      reject(signal?.reason);
    };
    stream.once("error", failed);
    stream.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      stream.write(text, (error) => {
        finish(error);
      });
    } catch (error) {
      finish(error);
    }
  });
}
export function colorEnabled(
  mode: OutputMode,
  choice: unknown,
  env: NodeJS.ProcessEnv,
  tty: boolean,
): boolean {
  if (mode !== "human" || env.NO_COLOR || choice === "never") return false;
  if (choice === "always") return true;
  if (env.FORCE_COLOR) return true;
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== "0") return true;
  return env.CLICOLOR === "0" ? false : tty;
}
const styles = {
  heading: "1;36",
  subject: "1;35",
  info: "36",
  success: "32",
  warning: "33",
  error: "31",
  secondary: "2",
};
export function styled(role: keyof typeof styles, value: unknown, color: boolean): string {
  // eslint-disable-next-line no-control-regex -- Escape terminal control bytes in human labels.
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, (character) =>
    JSON.stringify(character).slice(1, -1),
  );
  return color ? `\u001b[${styles[role]}m${text}\u001b[0m` : text;
}
export async function emitJson(stream: Writable, value: unknown, pretty = false): Promise<void> {
  await write(stream, JSON.stringify(value, null, pretty ? 2 : undefined) + "\n");
}
export class OperationOutput {
  private sequence = 0;
  private finished = false;
  readonly command: string;
  readonly mode: OutputMode;
  readonly stdout: Writable;
  get isFinished(): boolean {
    return this.finished;
  }
  private readonly observe?: (event: string, data: Record<string, unknown>) => Promise<void>;
  constructor(
    command: string,
    mode: OutputMode,
    stdout: Writable,
    observe?: (event: string, data: Record<string, unknown>) => Promise<void>,
  ) {
    this.command = command;
    this.mode = mode;
    this.stdout = stdout;
    if (observe !== undefined) this.observe = observe;
  }
  async event(event: string, data: Record<string, unknown> = {}): Promise<void> {
    if (this.finished) throw new Error("Cannot emit after the terminal result");
    await this.observe?.(event, data);
    if (["completed", "failed"].includes(event)) this.finished = true;
    if (this.mode === "ndjson")
      await emitJson(this.stdout, {
        schema_version: 1,
        command: this.command,
        event,
        sequence: ++this.sequence,
        ...data,
      });
  }
  async result(data: Record<string, unknown>): Promise<void> {
    const event = data.status === "error" || data.status === "partial" ? "failed" : "completed";
    if (this.mode === "ndjson") return this.event(event, data);
    if (this.finished) throw new Error("Cannot emit after the terminal result");
    await this.observe?.(event, data);
    this.finished = true;
    if (this.mode === "json")
      await emitJson(this.stdout, { schema_version: 1, command: this.command, ...data });
  }
}
