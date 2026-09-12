/* eslint-disable no-await-in-loop -- Each fixture is written before its corresponding assertion. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discover,
  importDocument,
  readDocument,
  resolveWorkspace,
  saveDocument,
} from "../src/documents.ts";

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

test("conversion rejects multi-document YAML and non-JSON values", async () => {
  for (const body of ["session_name: a\n---\nsession_name: b", "value: .nan", "a: &a [*a]"]) {
    const path = join(root, "bad.yaml");
    await writeFile(path, body);
    await expect(readDocument(path)).rejects.toThrow();
  }
});

test("tmuxinator import converts tabs, startup commands, roots and pane arrays", () => {
  expect(
    importDocument("tmuxinator", {
      project_name: "dev",
      root: "/tmp",
      pre: "echo ready",
      tabs: [{ editor: { root: "/", panes: ["vim", null], layout: "even-horizontal" } }],
    }),
  ).toEqual({
    session_name: "dev",
    start_directory: "/tmp",
    shell_command_before: ["echo ready"],
    windows: [
      {
        window_name: "editor",
        start_directory: "/",
        panes: ["vim", null],
        layout: "even-horizontal",
      },
    ],
  });
});

test("teamocil import handles nested sessions, filters, splits and commands", () => {
  expect(
    importDocument("teamocil", {
      session: {
        name: "dev",
        windows: [
          {
            name: "edit",
            filters: { before: ["echo before"], after: ["echo after"] },
            splits: [{ cmd: "vim", width: 50 }],
          },
        ],
      },
    }),
  ).toEqual({
    session_name: "dev",
    windows: [
      {
        window_name: "edit",
        shell_command_before: ["echo before"],
        shell_command_after: ["echo after"],
        panes: [{ shell_command: "vim" }],
      },
    ],
  });
});
