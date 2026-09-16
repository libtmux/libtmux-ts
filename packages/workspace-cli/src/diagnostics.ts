import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { expandPath, scalarText, type FileContext } from "./documents.ts";
import { CliError, colorEnabled, styled, write } from "./output.ts";
import type { OutputMode } from "./parser.ts";

const levels = { debug: 10, info: 20, warning: 30, error: 40, critical: 50 };
export type DiagnosticLevel = keyof typeof levels;

export class Diagnostics {
  private pending = Promise.resolve();
  private failed = false;
  private readonly level: DiagnosticLevel;
  private readonly mode: OutputMode;
  private readonly stderr: Writable;
  private readonly color: boolean;
  private readonly file: FileHandle | undefined;
  private readonly signal: AbortSignal | undefined;
  private constructor(
    level: DiagnosticLevel,
    mode: OutputMode,
    stderr: Writable,
    color: boolean,
    file?: FileHandle,
    signal?: AbortSignal,
  ) {
    this.level = level;
    this.mode = mode;
    this.stderr = stderr;
    this.color = color;
    this.file = file;
    this.signal = signal;
  }

  static async open(
    values: Record<string, unknown>,
    mode: OutputMode,
    context: FileContext & { stderr: Writable; signal?: AbortSignal },
  ): Promise<Diagnostics> {
    context.signal?.throwIfAborted();
    let file: FileHandle | undefined;
    if (values.log_file) {
      const path = resolve(context.cwd, expandPath(scalarText(values.log_file), context));
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK,
        0o600,
      );
      try {
        if (!(await file.stat()).isFile())
          throw new CliError("log_file", "Log destination must be a regular file");
      } catch (error) {
        await file.close();
        throw error;
      }
    }
    return new Diagnostics(
      (values.log_level ?? "warning") as DiagnosticLevel,
      mode,
      context.stderr,
      colorEnabled(
        mode,
        values.color,
        context.env,
        Boolean((context.stderr as { isTTY?: boolean }).isTTY),
      ),
      file,
      context.signal,
    );
  }

  accepts(level: DiagnosticLevel): boolean {
    return !this.failed && levels[level] >= levels[this.level];
  }

  async record(
    level: DiagnosticLevel,
    event: string,
    data: Record<string, unknown> = {},
    echo = true,
  ): Promise<void> {
    if (!this.accepts(level)) return;
    const record = { ...data, schema_version: 1, level, event, time: new Date().toISOString() };
    this.pending = this.pending.then(async () => {
      this.signal?.throwIfAborted();
      if (this.file) await this.file.appendFile(JSON.stringify(record) + "\n");
      if (!echo) return;
      if (this.mode !== "human")
        await write(this.stderr, JSON.stringify(record) + "\n", this.signal);
      else {
        const role =
          level === "error" || level === "critical"
            ? "error"
            : level === "warning"
              ? "warning"
              : "info";
        await write(
          this.stderr,
          `${styled(role, level, this.color)}: ${styled("subject", event, this.color)} ${styled("secondary", JSON.stringify(data), this.color)}\n`,
          this.signal,
        );
      }
    });
    try {
      await this.pending;
    } catch (error) {
      if (this.failed) return;
      this.failed = true;
      this.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      try {
        await write(
          this.stderr,
          this.mode === "human"
            ? `tmux-workspace: logging stopped: ${message}\n`
            : JSON.stringify({ schema_version: 1, code: "log_error", message }) + "\n",
          this.signal,
        );
      } catch {
        this.signal?.throwIfAborted();
      }
    }
  }

  async close(): Promise<void> {
    await this.pending.catch(() => {});
    await this.file?.close();
  }
}
