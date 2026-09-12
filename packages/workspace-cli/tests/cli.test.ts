/* eslint-disable no-await-in-loop -- CLI cases run sequentially to bound child process usage. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ltx-wcli-run-"));
  await mkdir(join(root, ".tmuxp"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function run(argv: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn(
    [process.execPath, new URL("../src/main.ts", import.meta.url).pathname, ...argv],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        TMUXP_CONFIGDIR: join(root, ".tmuxp"),
        XDG_CONFIG_HOME: join(root, ".config"),
        TMUX: "",
        TMUX_PANE: "",
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("every reference command has executable help", async () => {
  for (const command of [
    [],
    ["load"],
    ["freeze"],
    ["ls"],
    ["search"],
    ["convert"],
    ["import"],
    ["import", "teamocil"],
    ["import", "tmuxinator"],
    ["edit"],
    ["debug-info"],
    ["shell"],
    ["completion"],
  ]) {
    const result = await run([...command, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  }
});

test("completion prints sourceable scripts or structured content without a backend", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const script = await run(["completion", shell], { TMUX_BIN: "/missing-tmux" });
    expect(script.code).toBe(0);
    expect(script.stderr).toBe("");
    expect(script.stdout).toContain("tmux-workspace");
    for (const flag of ["--json", "--ndjson"]) {
      const machine = await run(["completion", shell, flag, "--color", "always"], {
        TMUX_BIN: "/missing-tmux",
      });
      expect(machine.code).toBe(0);
      expect(machine.stderr).toBe("");
      expect(JSON.parse(machine.stdout)).toMatchObject({
        schema_version: 1,
        command: "completion",
        status: "ok",
        shell,
        script: script.stdout,
      });
    }
  }
});

test("empty listing retains the JSON shape and emits no NDJSON records", async () => {
  const result = await run(["--json", "ls"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).workspaces).toEqual([]);
  expect(result.stderr).toBe("");
  expect((await run(["ls", "--json", "--ndjson"])).stdout).toBe("");
});

test("invalid machine arguments leave stdout empty with a structured usage diagnostic", async () => {
  for (const args of [
    ["load", "--json"],
    ["search", "--ndjson"],
    ["search", "[", "--json"],
    ["load", "x", "-2", "-8", "--json"],
  ]) {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).code).toBe("usage");
  }
});

test("legacy 88-color load fails before invoking tmux in every output mode", async () => {
  const wrapper = join(root, "tmux-probe");
  const marker = join(root, "called");
  await writeFile(wrapper, '#!/bin/sh\nprintf called > "$WORKSPACE_TEST_MARKER"\nexit 99\n', {
    mode: 0o700,
  });
  await writeFile(join(root, "dev.json"), JSON.stringify({ session_name: "dev", windows: [{}] }));
  for (const mode of ["human", "json", "ndjson"]) {
    const response = await run(
      ["load", "dev.json", "-d", "-8", ...(mode === "human" ? [] : [`--${mode}`])],
      { TMUX_BIN: wrapper, WORKSPACE_TEST_MARKER: marker },
    );
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(response.code).toBe(2);
    expect(response.stdout).toBe("");
    expect(response.stderr).toContain("88-color");
    if (mode !== "human") expect(JSON.parse(response.stderr).code).toBe("unsupported_color_mode");
  }
});

test("convert machine stdout preserves the document and performs no guessed write", async () => {
  await writeFile(
    join(root, "dev.yaml"),
    "session_name: dev\nwindows: []\nplugins: [demo.Plugin]\n",
  );
  const result = await run(["convert", "dev.yaml", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    session_name: "dev",
    windows: [],
    plugins: ["demo.Plugin"],
  });
  expect(result.stderr).toBe("");
});

test("search combines qualified fields and returns a stable empty array", async () => {
  await writeFile(
    join(root, ".tmuxp/dev.yaml"),
    "session_name: service\nwindows:\n  - window_name: editor\n    panes: [vim, 'npm test']\n",
  );
  const result = await run(["search", "session:service", "pane:vim", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)[0]).toMatchObject({
    name: "dev",
    session_name: "service",
    matched_fields: ["session_name", "pane"],
  });
  expect(JSON.parse((await run(["search", "absent", "--json"])).stdout)).toEqual([]);
  expect((await run(["search", "editor", "-f", "WINDOW", "--json"])).code).toBe(0);
  expect((await run(["search", "editor", "-f", "window,pane", "--json"])).code).toBe(2);
  expect(JSON.parse((await run(["search", "cmd:vim", "--json"])).stdout)).toEqual([]);
});

test("forced human color styles separate roles while machine data stays ANSI-free", async () => {
  await writeFile(
    join(root, ".tmuxp/dev.json"),
    JSON.stringify({ session_name: "Unicode Δ\n\u001b[31m", windows: [] }),
  );
  const human = await run(["--color", "always", "ls"], { NO_COLOR: "" });
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("\u001b[1;36m");
  expect(human.stdout).toContain("\u001b[1;35m");
  const machine = await run(["--color", "always", "ls", "--json"], {
    FORCE_COLOR: "1",
    NO_COLOR: "",
  });
  expect(machine.stdout).not.toContain("\u001b");
  expect(JSON.parse(machine.stdout).workspaces[0].session_name).toBe("Unicode Δ\n\u001b[31m");
});

test("editor uses quoted argv, returns child status, and keeps machine stdout structured", async () => {
  await writeFile(
    join(root, ".tmuxp/dev.json"),
    JSON.stringify({ session_name: "dev", windows: [] }),
  );
  const script = join(root, "test editor.js");
  await writeFile(
    script,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("editor diagnostic");process.exit(7);',
  );
  const result = await run(["edit", "dev", "--json"], {
    EDITOR: `'${process.execPath}' '${script}' --wait`,
  });
  expect(result.code).toBe(7);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    schema_version: 1,
    command: "edit",
    child_status: 7,
    status: "error",
    stderr: "editor diagnostic",
  });
  expect(JSON.parse(output.stdout)).toEqual(["--wait", join(root, ".tmuxp/dev.json")]);
});

test("diagnostics reports runtime and masked paths without needing a live server", async () => {
  const result = await run(["debug-info", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const data = JSON.parse(result.stdout);
  expect(data.port).toBe("typescript");
  expect(data.cwd).toBe("~");
  expect(data.runtime.version).toBeString();
  expect(data.tmux.version).toStartWith("tmux ");
});

test("load logging records preflight errors and honors the selected severity", async () => {
  const log = join(root, "load.ndjson");
  const result = await run([
    "--log-level",
    "debug",
    "load",
    "missing",
    "-d",
    "--json",
    "--log-file",
    log,
  ]);
  expect(result.code).toBe(1);
  const records = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    records.some((record) => record.level === "debug" && record.event === "command-started"),
  ).toBe(true);
  expect(
    records.some((record) => record.level === "error" && record.event === "command-failed"),
  ).toBe(true);
  expect((await stat(log)).mode & 0o777).toBe(0o600);
  const before = await readFile(log, "utf8");
  await run(["--log-level", "critical", "load", "missing", "-d", "--json", "--log-file", log]);
  expect(await readFile(log, "utf8")).toBe(before);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("\u001b");
  expect(
    result.stderr
      .trim()
      .split("\n")
      .every((line) => JSON.parse(line).schema_version === 1),
  ).toBe(true);
});
