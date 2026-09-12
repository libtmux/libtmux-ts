import { expect, test } from "bun:test";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { run } from "../src/app.ts";

test.each(["human", "json", "ndjson", "help"])(
  "cancellation releases blocked listing output %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "ltx-cli-output-"));
    await mkdir(join(root, ".tmuxp"));
    await writeFile(join(root, ".tmuxp/dev.json"), '{"session_name":"dev","windows":[]}');
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const stdout = new Writable({
      write(_chunk, _encoding, done) {
        release = done;
        controller.abort();
      },
    });
    const operation = run(["ls", ...(mode === "human" ? [] : [`--${mode}`])], {
      cwd: root,
      env: { HOME: root },
      stdin: Readable.from([]),
      stdout,
      stderr: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      signal: controller.signal,
    });
    try {
      expect(await Promise.race([operation, Bun.sleep(500).then(() => -1)])).toBe(130);
      expect(stdout.destroyed).toBe(false);
    } finally {
      release?.();
      stdout.destroy();
      await operation.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("cancellation releases blocked editor output and reaps the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-cli-output-"));
  await writeFile(join(root, "dev.json"), '{"session_name":"dev","windows":[]}');
  const script = join(root, "editor.js");
  await writeFile(script, "process.stdout.write(String(process.pid));setInterval(()=>{},1000);");
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let pid = 0;
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      pid = Number(String(chunk));
      release = done;
      controller.abort();
    },
  });
  const operation = run(["edit", "dev.json"], {
    cwd: root,
    env: { HOME: root, EDITOR: `'${process.execPath}' '${script}'` },
    stdin: Readable.from([]),
    stdout,
    stderr: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    signal: controller.signal,
  });
  try {
    expect(await Promise.race([operation, Bun.sleep(1500).then(() => -1)])).toBe(130);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    release?.();
    stdout.destroy();
    await operation.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI exits on interrupt with an unread stdout pipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-cli-pipe-"));
  const marker = join(root, "ready");
  const script = join(root, "editor.js");
  const pipe = join(root, "stdout.fifo");
  expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
  const reader = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK);
  const writer = openSync(pipe, constants.O_WRONLY);
  await writeFile(join(root, "dev.json"), '{"session_name":"dev","windows":[]}');
  await writeFile(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));process.stdout.write("x".repeat(16 * 1024 * 1024));setInterval(()=>{},1000);`,
  );
  const cli = Bun.spawn(
    [
      process.env.LIBTMUX_WORKSPACE_CLI_RUNTIME ?? process.execPath,
      process.env.LIBTMUX_WORKSPACE_CLI_ENTRY ??
        new URL("../src/main.ts", import.meta.url).pathname,
      "edit",
      "dev.json",
    ],
    {
      cwd: root,
      env: { ...process.env, HOME: root, EDITOR: `'${process.execPath}' '${script}'` },
      stdout: writer,
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  try {
    const deadline = Date.now() + 2000;
    // eslint-disable-next-line no-await-in-loop -- Wait for the owned editor before interrupting its CLI.
    while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(10);
    const editorPid = Number(await readFile(marker, "utf8"));
    await Bun.sleep(50);
    cli.kill("SIGINT");
    expect(await Promise.race([cli.exited, Bun.sleep(1500).then(() => -1)])).toBe(130);
    expect(() => process.kill(editorPid, 0)).toThrow();
  } finally {
    if (cli.exitCode === null) cli.kill("SIGKILL");
    await cli.exited;
    await cli.stderr.cancel();
    closeSync(writer);
    closeSync(reader);
    await rm(root, { recursive: true, force: true });
  }
});
