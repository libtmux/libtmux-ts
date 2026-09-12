import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { CLIContext } from "../src/app.ts";
import { LoadProgress } from "../src/progress.ts";
import type { Request } from "../src/parser.ts";

function fixture(values: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const chunks: string[] = [];
  const stderr = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    { isTTY: true, columns: 80, rows: 8 },
  );
  const context: CLIContext = {
    cwd: "/",
    env: { TERM: "xterm", NO_COLOR: "1", ...env },
    stdin: Readable.from([]),
    stdout: new Writable(),
    stderr,
  };
  const request: Request = { command: "load", mode: "human", values };
  return { context, request, stderr, chunks, create: () => LoadProgress.create(request, context)! };
}
const start = {
  session_name: "project",
  workspace: "project.yaml",
  window_total: 2,
  session_pane_total: 3,
};

test("extension progress omits counters and resumes native formatting for the next input", async () => {
  const f = fixture({ progress_format: "{session}:{window_total}:{session_pane_total}" });
  const progress = f.create();
  await progress.event("workspace-started", {
    session_name: "extension",
    workspace: "custom.yaml",
  });
  expect(f.chunks.at(-1)).toBe("Loading workspace: extension");
  await progress.event("workspace-completed", {});
  await progress.event("workspace-started", start);
  expect(f.chunks.at(-1)).toBe("project:2:3");
});

test("progress distinguishes created panes from configured panes and safely expands custom tokens", async () => {
  const f = fixture({
    progress_format:
      "{{session}}:{constructor}:{session}:{session_pane_progress}:{window_progress_rel}:{overall_percent}",
  });
  const progress = f.create();
  await progress.event("workspace-started", start);
  expect(f.chunks.join("")).toBe("{session}:{constructor}:project:0/3:0/2:0");
  await progress.event("window-created", { window_name: "one", window_ordinal: 1, pane_total: 2 });
  await progress.event("pane-created", { pane_ordinal: 1 });
  await progress.clear();
  await progress.event("warning", {});
  expect(f.chunks.at(-1)).toContain("project:0/3:0/2:0");
  await progress.event("pane-completed", {});
  await progress.event("window-completed", {});
  await progress.clear();
  await progress.event("warning", {});
  expect(f.chunks.at(-1)).toContain("project:1/3:1/2:33");
});

test.each(["default", "minimal", "window", "pane", "verbose", "toString"])(
  "progress preset or literal %s is usable",
  async (format) => {
    const f = fixture({ progress_format: format });
    await f.create().event("workspace-started", start);
    if (format === "toString") expect(f.chunks.join("")).toBe("toString");
    else expect(f.chunks.join("")).toContain("Loading workspace: project");
  },
);

test("progress respects terminal controls, environment settings and explicit overrides", () => {
  const f = fixture({}, { TMUXP_PROGRESS_LINES: "bad" });
  expect(f.create).toThrow("Progress lines");
  f.request.values.panel_lines = 0;
  expect(f.create()).toBeDefined();
  for (const mode of ["json", "ndjson"] as const) {
    f.request.mode = mode;
    expect(f.create()).toBeUndefined();
  }
  f.request.mode = "human";
  f.stderr.isTTY = false;
  expect(f.create()).toBeUndefined();
  f.stderr.isTTY = true;
  f.request.values.no_progress = true;
  expect(f.create()).toBeUndefined();
  f.request.values.no_progress = false;
  f.context.env.TMUXP_PROGRESS = "0";
  expect(f.create()).toBeUndefined();
  delete f.context.env.TMUXP_PROGRESS;
  f.context.env.TERM = "dumb";
  expect(f.create()).toBeUndefined();
});

test("the script panel bounds history, separates streams, clips wide text and clears before raw output", async () => {
  const f = fixture({ panel_lines: -1, progress_format: "{session}" });
  f.stderr.columns = 9;
  f.stderr.rows = 4;
  const progress = f.create();
  await progress.event("workspace-started", { ...start, session_name: "界界界界界" });
  expect(stripVTControlCharacters(f.chunks[0]!)).toBe("界界界…");
  await progress.event("script-output", {
    stream: "stdout",
    text: "x".repeat(200000) + "\nlast\nout",
  });
  await progress.event("script-output", { stream: "stderr", text: "err\u001b[2J" });
  await progress.clear();
  await progress.event("warning", {});
  const frame = stripVTControlCharacters(f.chunks.at(-1)!);
  expect(frame.split("\n")).toHaveLength(3);
  expect(frame).toContain("\nout\nerr\\u00…");
  expect(frame).not.toContain("last");
  expect(f.chunks.every((chunk) => chunk.length < 100)).toBe(true);
  await progress.event("workspace-completed", {});
  expect(f.chunks.at(-1)).toBe("\r\u001b[2A\u001b[0J");
  const raw = fixture({ panel_lines: 0 });
  const rawProgress = raw.create();
  await rawProgress.event("workspace-started", start);
  expect(await rawProgress.event("script-output", { text: "raw" })).toBe(false);
  expect(raw.chunks.at(-1)).toBe("\r\u001b[0J");
});

test("fast event bursts redraw at most once and blocked progress remains cancellable", async () => {
  const f = fixture();
  const progress = f.create();
  await progress.event("workspace-started", start);
  await Promise.all(
    Array.from({ length: 100 }, () => progress.event("pane-created", { pane_ordinal: 1 })),
  );
  expect(f.chunks).toHaveLength(1);
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const stream = Object.assign(
    new Writable({
      write(_chunk, _encoding, done) {
        release = done;
        controller.abort();
      },
    }),
    { isTTY: true },
  );
  const blocked = LoadProgress.create(f.request, {
    ...f.context,
    stderr: stream,
    signal: controller.signal,
  })!;
  await expect(blocked.event("workspace-started", start)).rejects.toThrow();
  expect(stream.destroyed).toBe(false);
  release?.();
  await expect(blocked.clear(AbortSignal.timeout(100))).rejects.toThrow();
  release?.();
});

test("an interrupted clear retains the frame for bounded cleanup", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.context.signal = controller.signal;
  const progress = f.create();
  await progress.event("workspace-started", start);
  controller.abort();
  await expect(progress.clear()).rejects.toThrow();
  await progress.clear(AbortSignal.timeout(100));
  expect(f.chunks.at(-1)).toBe("\r\u001b[0J");
});

test("the script panel follows arrival order across incomplete streams", async () => {
  const f = fixture({ panel_lines: 1, progress_format: "{session}" });
  const progress = f.create();
  await progress.event("workspace-started", start);
  await progress.event("script-output", { stream: "stderr", text: "old" });
  await progress.event("script-output", { stream: "stdout", text: "new\n" });
  await progress.clear();
  await progress.event("warning", {});
  expect(f.chunks.at(-1)).toBe("project\nnew");
});

test("clearing after a width change covers the frame's reflowed rows", async () => {
  const f = fixture({ progress_format: "x".repeat(70) });
  const progress = f.create();
  await progress.event("workspace-started", start);
  f.stderr.columns = 20;
  await progress.clear();
  expect(f.chunks.at(-1)).toBe("\r\u001b[3A\u001b[0J");
});
