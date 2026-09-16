import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { run, type CLIContext } from "../src/app.ts";
import { Diagnostics } from "../src/diagnostics.ts";

function captured() {
  let stdout = "";
  let stderr = "";
  const context: CLIContext = {
    cwd: tmpdir(),
    env: { HOME: tmpdir(), TMUXP_CONFIGDIR: "/missing-workspaces" },
    stdin: Readable.from([]),
    stdout: new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    }),
    stderr: new Writable({
      write(chunk, _encoding, done) {
        stderr += String(chunk);
        done();
      },
    }),
  };
  return { context, output: () => ({ stdout, stderr }) };
}

test("a failed error log preserves the command diagnostic and exit status", async () => {
  const capture = captured();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebind the saved method to each real logger below.
  const original = Diagnostics.prototype.record;
  const record = spyOn(Diagnostics.prototype, "record").mockImplementation(async function (
    this: Diagnostics,
    ...args
  ) {
    if (args[1] === "command-failed") throw new Error("log append failed");
    return original.apply(this, args);
  });
  try {
    expect(await run(["load", "missing-workspace", "-d", "--json"], capture.context)).toBe(1);
    expect(capture.output().stdout).toBe("");
    const records = capture
      .output()
      .stderr.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      code: "workspace_error",
      message: "Workspace not found: missing-workspace",
    });
    expect(records[1]).toMatchObject({ code: "log_error", message: "log append failed" });
  } finally {
    record.mockRestore();
  }
});

test("closing a log reports failure without replacing a completed result", async () => {
  const capture = captured();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebind the saved method to each real logger below.
  const original = Diagnostics.prototype.close;
  const close = spyOn(Diagnostics.prototype, "close").mockImplementation(
    async function (this: Diagnostics) {
      await original.call(this);
      throw new Error("log close failed");
    },
  );
  try {
    expect(await run(["ls", "--json"], capture.context)).toBe(0);
    expect(JSON.parse(capture.output().stdout).workspaces).toBeArray();
    expect(JSON.parse(capture.output().stderr)).toMatchObject({
      code: "log_error",
      message: "log close failed",
    });
  } finally {
    close.mockRestore();
  }
});

test.skipIf(process.platform !== "linux")(
  "cancelling blocked diagnostics closes its log file",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-wcli-log-"));
    const log = join(root, "load.ndjson");
    const capture = captured();
    expect(
      await run(["load", "missing", "-d", "--json", "--log-file", log], {
        ...capture.context,
        signal: AbortSignal.abort(),
      }),
    ).toBe(130);
    expect(await Bun.file(log).exists()).toBe(false);
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const blocked = new Writable({
      write(_chunk, _encoding, done) {
        if (controller.signal.aborted) return done();
        release = done;
        controller.abort();
      },
    });
    const operation = run(
      ["--log-level", "debug", "load", "missing", "-d", "--json", "--log-file", log],
      {
        ...capture.context,
        stderr: blocked,
        signal: controller.signal,
      },
    );
    try {
      expect(await Promise.race([operation, Bun.sleep(500).then(() => -1)])).toBe(130);
      expect(JSON.parse((await readFile(log, "utf8")).trim()).event).toBe("command-started");
      const descriptors = await Promise.all(
        (await readdir("/proc/self/fd")).map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => ""),
        ),
      );
      expect(descriptors).not.toContain(log);
      expect(blocked.destroyed).toBe(false);
    } finally {
      release?.();
      await operation.catch(() => {});
      blocked.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
);
