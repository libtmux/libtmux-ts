/* eslint-disable no-await-in-loop -- Each fixture is written before its corresponding assertion. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Document,
  discover,
  readDocument,
  resolveWorkspace,
  saveDocument,
} from "../src/documents.ts";

import { importDocument } from "../src/imports.ts";

let root: string;
let context: { cwd: string; env: Record<string, string> };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ltx-wcli-doc-"));
  context = { cwd: join(root, "project", "child"), env: { HOME: root } };
  for (const dir of [context.cwd, join(root, ".tmuxp"), join(root, ".config", "tmuxp")])
    await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("discovery selects one local file per ancestor and the active global directory", async () => {
  for (const file of [
    "project/.tmuxp.yml",
    "project/.tmuxp.yaml",
    ".tmuxp/legacy.yaml",
    ".config/tmuxp/dev.json",
  ])
    await writeFile(join(root, file), JSON.stringify({ session_name: file, windows: [] }));
  const result = await discover(context, true);
  expect(result.workspaces.map((row) => row.name)).toEqual([".tmuxp", "dev"]);
  expect(result.workspaces.map((row) => row.source)).toEqual(["local", "global"]);
  expect(result.global_workspace_dirs.find((row) => row.active)?.source).toBe("XDG default");
  expect(result.workspaces[0]?.path).toBe("~/project/.tmuxp.yaml");
});

test("a bare name searches globals while an extension selects a cwd file", async () => {
  await writeFile(join(root, ".config/tmuxp/dev.yaml"), "session_name: global\n");
  await writeFile(join(context.cwd, "dev.yaml"), "session_name: local\n");
  expect(await resolveWorkspace("dev", context)).toBe(join(root, ".config/tmuxp/dev.yaml"));
  expect(await resolveWorkspace("dev.yaml", context)).toBe(join(context.cwd, "dev.yaml"));
});

test("discovery deduplicates directory aliases and excludes hidden files", async () => {
  const directory = join(root, ".tmuxp");
  context.env.TMUXP_CONFIGDIR = directory;
  await writeFile(join(directory, "dev.yaml"), "session_name: dev\n");
  await writeFile(join(directory, ".hidden.yaml"), "session_name: hidden\n");
  const result = await discover(context);
  expect(result.workspaces.map((record) => record.name)).toEqual(["dev"]);
  expect(result.global_workspace_dirs.filter((record) => record.active)).toHaveLength(1);
});

test("conversion preserves unknown fields and prevents accidental replacement", async () => {
  const path = join(root, "source.yaml");
  await writeFile(
    path,
    "session_name: dev\nplugins: [example.Plugin]\nwindows: []\nextra:\n  nested: [true, 42, null]\n",
  );
  const document = await readDocument(path);
  const target = join(root, "target.json");
  await saveDocument(document, target, "json", false);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(document);
  await expect(saveDocument({ session_name: "changed" }, target, "json", false)).rejects.toThrow(
    /exists/,
  );
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(document);
  await saveDocument({ session_name: "changed" }, target, "json", true);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ session_name: "changed" });
});

test("YAML conversion quotes scalars a 1.1 or 1.2 resolver would misread", async () => {
  const document = {
    session_name: "dev",
    windows: [
      {
        window_name: "yes",
        options: { "automatic-rename": "off", "synchronize-panes": "on" },
        panes: ["echo hi"],
      },
    ],
    tricky: {
      bool_words: ["yes", "YES", "no", "on", "Off", "y", "N", "true", "False"],
      null_words: ["null", "~", ""],
      numbers: ["1.0", "08", "0x1F", "0o7", "1e3", ".inf", ".nan", "1_000", "1:30"],
      ordinary: "plain-string",
    },
  };
  const target = join(root, "tricky.yaml");
  await saveDocument(document, target, "yaml", false);
  // The native reader parses YAML 1.2 core, so must recover this document too.
  expect(await readDocument(target)).toEqual(document);
  // tmuxp reads YAML 1.1 (PyYAML); simulate its resolver against the same file.
  const legacy = (await import("yaml")).parse(await readFile(target, "utf8"), {
    version: "1.1",
  });
  expect(legacy).toEqual(document);
});

test("conversion rejects multi-document YAML and non-JSON values", async () => {
  for (const body of ["session_name: a\n---\nsession_name: b", "value: .nan", "a: &a [*a]"]) {
    const path = join(root, "bad.yaml");
    await writeFile(path, body);
    await expect(readDocument(path)).rejects.toThrow();
  }
});

test("cancelled saves preserve existing files and do not publish new files", async () => {
  const target = join(root, "target.json");
  await writeFile(target, "original");
  for (const existing of [true, false]) {
    if (!existing) await rm(target);
    await expect(
      saveDocument({ session_name: "cancelled" }, target, "json", existing, AbortSignal.abort()),
    ).rejects.toThrow();
    if (existing) expect(await readFile(target, "utf8")).toBe("original");
    else expect(await Bun.file(target).exists()).toBe(false);
  }
});

test("tmuxinator import converts legacy names, tabs and pane roots", () => {
  const result = importDocument(
    "tmuxinator",
    {
      project_name: "dev",
      root: "/tmp",
      pre_window: "echo ready",
      tabs: [{ editor: { root: "/", panes: ["vim", null], layout: "even-horizontal" } }],
    },
    context,
  );
  expect(result.session_name).toBe("dev");
  expect(result.start_directory).toBe("/tmp");
  expect(result.shell_command_before).toEqual([{ cmd: "echo ready" }]);
  expect(result.windows).toEqual([
    {
      window_name: "editor",
      start_directory: "/",
      layout: "even-horizontal",
      focus: true,
      panes: [{ shell_command: [{ cmd: "vim" }], focus: true }, { shell_command: [] }],
    },
  ]);
});

test("teamocil import handles nested sessions, legacy splits and literal ERB-like text", () => {
  const result = importDocument(
    "teamocil",
    {
      session: {
        name: "dev",
        windows: [{ name: "edit", splits: [{ cmd: "echo <%= literal %>" }] }],
      },
    },
    context,
  );
  expect(result.session_name).toBe("dev");
  expect(result.windows).toEqual([
    {
      window_name: "edit",
      focus: true,
      panes: [{ shell_command: [{ cmd: "echo <%= literal %>" }], focus: true }],
    },
  ]);
});

test("teamocil import derives session_name from the file when the document has none", () => {
  const result = importDocument(
    "teamocil",
    {
      windows: [
        {
          name: "sample-window",
          root: "/tmp",
          layout: "tiled",
          panes: [{ cmd: "echo one" }, { cmd: ["echo two-a", "echo two-b"], focus: true }],
        },
      ],
    },
    context,
    "teamv1",
  );
  expect(result.session_name).toBe("teamv1");
  expect(result.start_directory).toBe(context.cwd);
  expect(result.windows).toEqual([
    {
      window_name: "sample-window",
      start_directory: "/tmp",
      layout: "tiled",
      focus: true,
      panes: [
        { shell_command: [{ cmd: "echo one" }] },
        { shell_command: [{ cmd: "echo two-a; echo two-b" }], focus: true },
      ],
    },
  ]);
});

test("native imports preserve Teamocil command groups and modern pane fields", () => {
  const source: Document = {
    session: {
      name: "modern",
      windows: [
        {
          name: "main",
          focus: true,
          options: { "automatic-rename": false },
          panes: [{ commands: ["cd project", "printf ready"], focus: true }, "blank"],
        },
      ],
    },
  };
  const before = structuredClone(source);
  const result = importDocument("teamocil", source, context);
  expect(result.start_directory).toBe(context.cwd);
  expect(result.windows).toEqual([
    {
      window_name: "main",
      focus: true,
      options: { "automatic-rename": false },
      panes: [
        { shell_command: [{ cmd: "cd project; printf ready" }], focus: true },
        { shell_command: [{ cmd: "blank" }] },
      ],
    },
  ]);
  expect(source).toEqual(before);
});

test("native imports preserve one-pane command arrays and pre-window sequences", () => {
  const result = importDocument(
    "tmuxinator",
    {
      name: "grouped",
      root: "project",
      pre_window: ["false", "printf unreachable"],
      windows: [{ main: ["printf first", "printf second"] }],
    },
    context,
  );
  expect(result.start_directory).toBe(join(context.cwd, "project"));
  expect(result.shell_command_before).toEqual([{ cmd: "false; printf unreachable" }]);
  expect(result.windows).toEqual([
    {
      window_name: "main",
      focus: true,
      panes: [{ shell_command: [{ cmd: "printf first" }, { cmd: "printf second" }], focus: true }],
    },
  ]);
});

test("native imports keep window pre failure groups distinct from project pre_window", () => {
  const result = importDocument(
    "tmuxinator",
    {
      name: "grouped",
      windows: [{ main: { pre: ["false", "printf unreachable"], panes: ["true"] } }],
    },
    context,
  );
  expect((result.windows as Document[])[0]?.shell_command_before).toEqual([
    { cmd: "false && printf unreachable" },
  ]);
});

test("native imports resolve non-null aliases and reject ERB templates", () => {
  const result = importDocument(
    "tmuxinator",
    {
      name: "aliases",
      project_name: null,
      root: null,
      project_root: "project",
      windows: [{ main: "true" }],
      tabs: null,
    },
    context,
  );
  expect(result.session_name).toBe("aliases");
  expect(result.start_directory).toBe(join(context.cwd, "project"));
  expect(() =>
    importDocument(
      "tmuxinator",
      {
        name: "template",
        windows: [{ main: "printf <%= command %>" }],
      },
      context,
    ),
  ).toThrow("ERB");
});

test.each([
  ["tmuxinator", { name: "x", pre: "touch project-hook", windows: [{ main: "true" }] }],
  ["tmuxinator", { name: "x", socket_name: "other", windows: [{ main: "true" }] }],
  ["tmuxinator", { name: "x", windows: [{ main: { panes: [{ editor: ["true"] }] } }] }],
  ["tmuxinator", { name: "x", windows: [{ main: { pre: "touch unused" } }] }],
  ["tmuxinator", { name: "x", windows: [] }],
  ["teamocil", { name: "x", windows: [{ name: "main", clear: true, panes: [{ cmd: "true" }] }] }],
  [
    "teamocil",
    {
      name: "x",
      windows: [{ name: "main", filters: { after: ["touch after"] }, panes: [{ cmd: "true" }] }],
    },
  ],
  ["teamocil", { name: "x", windows: [{ name: "main", panes: [{ cmd: "true", width: 50 }] }] }],
  ["teamocil", { name: "x", windows: [{ name: "main", panes: [{ commands: [42] }] }] }],
] satisfies ["tmuxinator" | "teamocil", Document][])(
  "native imports refuse unsupported or invalid %s fields",
  (kind, source) => {
    expect(() => importDocument(kind, structuredClone(source), context)).toThrow();
  },
);
