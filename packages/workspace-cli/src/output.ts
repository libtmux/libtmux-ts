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
export async function write(stream: Writable, text: string): Promise<void> {
  if (stream.destroyed || stream.writableEnded)
    throw stream.errored ?? new CliError("output_closed", "Output stream closed");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stream.off("close", closed);
      if (error) {
        setImmediate(() => {
          stream.off("error", failed);
        });
        reject(error);
      } else {
        stream.off("error", failed);
        resolve();
      }
    };
    const failed = (error: Error) => {
      finish(error);
    };
    const closed = () => {
      finish(new CliError("output_closed", "Output stream closed before the write completed"));
    };
    stream.once("error", failed);
    stream.once("close", closed);
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
  constructor(command: string, mode: OutputMode, stdout: Writable) {
    this.command = command;
    this.mode = mode;
    this.stdout = stdout;
  }
  async event(event: string, data: Record<string, unknown> = {}): Promise<void> {
    if (this.finished) throw new Error("Cannot emit after the terminal result");
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
    if (this.mode === "json")
      await emitJson(this.stdout, { schema_version: 1, command: this.command, ...data });
    else if (this.mode === "ndjson")
      await this.event(
        data.status === "error" || data.status === "partial" ? "failed" : "completed",
        data,
      );
  }
}
