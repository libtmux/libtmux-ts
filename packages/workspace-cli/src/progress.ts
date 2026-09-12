import truncate from "cli-truncate";
import stringWidth from "string-width";
import type { CLIContext } from "./app.ts";
import { scalarText } from "./documents.ts";
import { CliError, colorEnabled, styled, write } from "./output.ts";
import type { Request } from "./parser.ts";

const presets: Record<string, string> = {
  default: "Loading workspace: {session} {bar} {progress} {window}",
  minimal: "Loading workspace: {session} [{window_progress}]",
  window: "Loading workspace: {session} {window_bar} {window_progress_rel}",
  pane: "Loading workspace: {session} {pane_bar} {session_pane_progress}",
  verbose:
    "Loading workspace: {session} [window {window_index} of {window_total} · pane {pane_index} of {pane_total}] {window}",
};
const retainedCharacters = 65536;
type ScriptLine = { text: string; order: number };

export class LoadProgress {
  private painted: number[] = [];
  private lastDraw = -Infinity;
  private active = false;
  private windowIndex = 0;
  private windowTotal = 0;
  private windowsDone = 0;
  private paneIndex = 0;
  private paneTotal = 0;
  private panesDone = 0;
  private sessionPaneTotal = 0;
  private sessionPanesDone = 0;
  private session = "";
  private window = "";
  private workspace = "";
  private history: ScriptLine[] = [];
  private pending: Partial<Record<"stdout" | "stderr", ScriptLine>> = {};
  private scriptOrder = 0;
  private rawLineOpen = false;
  private pendingWrite = Promise.resolve();
  private readonly context: CLIContext;
  private readonly format: string;
  private readonly lines: number;
  private readonly color: boolean;

  private constructor(context: CLIContext, format: string, lines: number, color: boolean) {
    this.context = context;
    this.format = format;
    this.lines = lines;
    this.color = color;
  }

  static create(request: Request, context: CLIContext): LoadProgress | undefined {
    if (
      request.mode !== "human" ||
      !(context.stderr as { isTTY?: boolean }).isTTY ||
      context.env.TERM === "dumb" ||
      request.values.no_progress ||
      context.env.TMUXP_PROGRESS === "0"
    )
      return undefined;
    const value = request.values.panel_lines ?? context.env.TMUXP_PROGRESS_LINES ?? 3;
    if (
      !/^-?\d+$/.test(scalarText(value)) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < -1
    )
      throw new CliError("usage", "Progress lines must be an integer at least -1", 2);
    const format = scalarText(
      request.values.progress_format ?? context.env.TMUXP_PROGRESS_FORMAT ?? "default",
    );
    return new LoadProgress(
      context,
      Object.hasOwn(presets, format) ? presets[format]! : format,
      Number(value),
      colorEnabled(request.mode, request.values.color, context.env, true),
    );
  }

  private dimensions(): { columns: number; rows: number } {
    const stream = this.context.stderr as { columns?: number; rows?: number };
    const dimension = (value: number | undefined, fallback: number) =>
      value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    return { columns: dimension(stream.columns, 80), rows: dimension(stream.rows, 24) };
  }

  private panelRows(): number {
    const available = Math.max(0, this.dimensions().rows - 2);
    return this.lines === -1 ? available : Math.min(this.lines, available);
  }

  private script(stream: "stdout" | "stderr", text: string): void {
    const chunks = ((this.pending[stream]?.text ?? "") + text)
      .slice(-retainedCharacters)
      .split(/\r\n|[\r\n]/);
    const partial = chunks.pop() ?? "";
    this.history = [
      ...this.history,
      ...chunks.map((line) => ({ text: line, order: ++this.scriptOrder })),
    ].slice(-Math.max(1, this.panelRows()));
    let remaining = retainedCharacters;
    for (let index = this.history.length - 1; index >= 0; index--) {
      const line = this.history[index]!;
      line.text = line.text.slice(-remaining);
      remaining -= line.text.length;
      if (remaining === 0) {
        this.history = this.history.slice(index);
        break;
      }
    }
    if (partial) this.pending[stream] = { text: partial, order: ++this.scriptOrder };
    else delete this.pending[stream];
  }

  private tokens(): Record<string, string | number> {
    const ratio = (done: number, total: number) => (total ? `${done}/${total}` : "");
    const bar = (done: number, total: number) => {
      const filled = total ? Math.min(10, Math.floor((10 * done) / total)) : 0;
      return (
        styled("success", "█".repeat(filled), this.color) +
        styled("secondary", "░".repeat(10 - filled), this.color)
      );
    };
    const windowProgress = this.windowIndex ? ratio(this.windowIndex, this.windowTotal) : "";
    const paneProgress = this.paneIndex ? ratio(this.paneIndex, this.paneTotal) : "";
    return {
      session: styled("subject", this.session, this.color),
      workspace_path: styled("info", this.workspace, this.color),
      window: styled("heading", this.window, this.color),
      window_index: this.windowIndex,
      window_total: this.windowTotal,
      window_progress: windowProgress,
      pane_index: this.paneIndex,
      pane_total: this.paneTotal,
      pane_progress: paneProgress,
      progress: [windowProgress && `${windowProgress} win`, paneProgress && `${paneProgress} pane`]
        .filter(Boolean)
        .join(" · "),
      windows_done: this.windowsDone,
      windows_remaining: Math.max(0, this.windowTotal - this.windowsDone),
      window_progress_rel: ratio(this.windowsDone, this.windowTotal),
      pane_done: this.panesDone,
      pane_remaining: Math.max(0, this.paneTotal - this.panesDone),
      pane_progress_rel: ratio(this.panesDone, this.paneTotal),
      session_pane_total: this.sessionPaneTotal,
      session_panes_done: this.sessionPanesDone,
      session_panes_remaining: Math.max(0, this.sessionPaneTotal - this.sessionPanesDone),
      session_pane_progress: ratio(this.sessionPanesDone, this.sessionPaneTotal),
      overall_percent: this.sessionPaneTotal
        ? Math.floor((100 * this.sessionPanesDone) / this.sessionPaneTotal)
        : 0,
      summary: `[${this.windowsDone} win, ${this.sessionPanesDone} panes]`,
      bar: bar(this.sessionPanesDone, this.sessionPaneTotal),
      pane_bar: bar(this.sessionPanesDone, this.sessionPaneTotal),
      window_bar: bar(this.windowsDone, this.windowTotal),
      status_icon: "",
    };
  }

  private erase(): string {
    const { columns, rows } = this.dimensions();
    const height = Math.min(
      rows,
      this.painted.reduce((total, width) => total + Math.max(1, Math.ceil(width / columns)), 0),
    );
    return height ? `\r${height > 1 ? `\u001b[${height - 1}A` : ""}\u001b[0J` : "";
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pendingWrite.then(operation);
    this.pendingWrite = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  clear(signal = this.context.signal): Promise<void> {
    return this.enqueue(async () => {
      await this.separate(signal);
      await this.eraseFrame(signal);
    });
  }

  private async separate(signal = this.context.signal): Promise<void> {
    if (this.rawLineOpen) await write(this.context.stderr, "\n", signal);
    this.rawLineOpen = false;
  }

  private async eraseFrame(signal = this.context.signal): Promise<void> {
    const erase = this.erase();
    if (erase) await write(this.context.stderr, erase, signal);
    this.painted = [];
  }

  private async draw(force = false): Promise<void> {
    if (!this.active || (!force && this.painted.length && performance.now() - this.lastDraw < 50))
      return;
    await this.separate();
    const tokens = this.tokens();
    const label = styled("secondary", this.format, false).replace(
      /\{\{|\}\}|\{([^{}]+)\}/g,
      (match, token: string | undefined) =>
        match === "{{"
          ? "{"
          : match === "}}"
            ? "}"
            : token && Object.hasOwn(tokens, token)
              ? String(tokens[token])
              : match,
    );
    const count = this.panelRows();
    const panel = count
      ? [...this.history, ...Object.values(this.pending)]
          .sort((a, b) => a.order - b.order)
          .slice(-count)
      : [];
    const rows = [label, ...panel.map((line) => styled("secondary", line.text, this.color))].map(
      (line) => truncate(line, Math.max(0, this.dimensions().columns - 1)),
    );
    const erase = this.erase();
    this.context.signal?.throwIfAborted();
    this.painted = rows.map((line) => stringWidth(line));
    this.lastDraw = performance.now();
    await write(this.context.stderr, erase + rows.join("\n"), this.context.signal);
  }

  event(event: string, data: Record<string, unknown>): Promise<boolean> {
    return this.enqueue(() => this.update(event, data));
  }

  private async update(event: string, data: Record<string, unknown>): Promise<boolean> {
    switch (event) {
      case "workspace-started":
        this.active = true;
        this.session = scalarText(data.session_name ?? "");
        this.workspace = scalarText(data.workspace ?? "");
        this.window = "";
        this.windowTotal = Number(data.window_total);
        this.sessionPaneTotal = Number(data.session_pane_total);
        this.windowIndex =
          this.windowsDone =
          this.paneIndex =
          this.paneTotal =
          this.panesDone =
          this.sessionPanesDone =
            0;
        this.history = [];
        this.pending = {};
        await this.draw(true);
        break;
      case "window-created":
        this.window = scalarText(data.window_name ?? "");
        this.windowIndex = Number(data.window_ordinal);
        this.paneTotal = Number(data.pane_total);
        this.paneIndex = this.panesDone = 0;
        await this.draw();
        break;
      case "pane-created":
        this.paneIndex = Number(data.pane_ordinal);
        await this.draw();
        break;
      case "pane-completed":
        this.panesDone++;
        this.sessionPanesDone++;
        await this.draw();
        break;
      case "window-completed":
        this.windowsDone++;
        await this.draw();
        break;
      case "script-output":
        if (this.lines === 0 || this.panelRows() === 0) {
          await this.eraseFrame();
          const stream = data.stream === "stderr" ? "stderr" : "stdout";
          const text = scalarText(data.text ?? "");
          if (text && (this.context[stream] as { isTTY?: boolean }).isTTY)
            this.rawLineOpen = !text.endsWith("\n");
          return false;
        }
        {
          const first = !this.history.length && !this.pending.stdout && !this.pending.stderr;
          this.script(data.stream === "stderr" ? "stderr" : "stdout", scalarText(data.text ?? ""));
          await this.draw(first);
        }
        return true;
      case "workspace-completed":
      case "completed":
      case "failed":
        this.active = false;
        await this.separate();
        await this.eraseFrame();
        break;
      default:
        await this.draw();
    }
    return false;
  }
}
