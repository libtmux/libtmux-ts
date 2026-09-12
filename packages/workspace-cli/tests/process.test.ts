import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { processRun, tokenize } from "../src/process.ts";
import { write } from "../src/output.ts";
import { runWithCleanup } from "../../libtmux/src/_internal/test/testkit.js";

test("process arguments preserve quoted spaces and empty values without a shell", () => {
  expect(tokenize('editor --wait "a b" \'\' x\\ y "$HOME"')).toEqual([
    "editor",
    "--wait",
    "a b",
    "",
    "x y",
    "$HOME",
  ]);
  expect(() => tokenize('editor "unfinished')).toThrow(/quote/);
  expect(tokenize('cmd "\\$HOME" "\\`"')).toEqual(["cmd", "\\$HOME", "\\`"]);
  expect(tokenize('cmd "a\\\nb"')).toEqual(["cmd", "a\\\nb"]);
});

test("child output drains both streams and decodes split Unicode with bounded retention", async () => {
  let stdout = "";
  let stderr = "";
  const result = await processRun(
    [
      process.execPath,
      "-e",
      'process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>{process.stdout.write(Buffer.from([0x8c,0x90]));process.stdout.write("a".repeat(200000));process.stderr.write("b".repeat(200000));},30)',
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      output: async (stream, text) => {
        if (stream === "stdout") stdout += text;
        else stderr += text;
      },
    },
  );
  expect(result.code).toBe(0);
  expect(stdout).toBe("🌐" + "a".repeat(200000));
  expect(stderr).toBe("b".repeat(200000));
  expect(result.stdout).toStartWith("🌐");
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65536);
  expect(result.truncated).toEqual({ stdout: true, stderr: true });
});

test("a failed output consumer terminates and reaps its child", async () => {
  const start = performance.now();
  await expect(
    processRun(
      [process.execPath, "-e", 'setInterval(()=>process.stdout.write("x".repeat(100000)),5)'],
      {
        cwd: process.cwd(),
        env: process.env,
        output: async () => {
          throw new Error("consumer closed");
        },
      },
    ),
  ).rejects.toThrow("consumer closed");
  expect(performance.now() - start).toBeLessThan(2000);
});

test("child input progresses while both output streams are drained", async () => {
  const input = "payload Δ\n".repeat(30_000);
  const result = await processRun(
    [
      process.execPath,
      "-e",
      'process.stderr.write("x".repeat(200000));let bytes=0;for await(const chunk of process.stdin)bytes+=chunk.length;process.stdout.write(String(bytes));',
    ],
    { cwd: process.cwd(), env: process.env, input },
  );
  expect(result.code).toBe(0);
  expect(Number(result.stdout)).toBe(Buffer.byteLength(input));
  expect(result.truncated.stderr).toBe(true);
});

test("cancellation joins a child with pending input and returns interrupt status", async () => {
  const controller = new AbortController();
  const result = await processRun(
    [process.execPath, "-e", 'process.stdout.write("ready");setInterval(()=>{},1000)'],
    {
      cwd: process.cwd(),
      env: process.env,
      input: "x".repeat(200_000),
      signal: controller.signal,
      output: async () => {
        controller.abort();
      },
    },
  );
  expect(result.code).toBe(130);
});

test("stream writes observe asynchronous errors and closure before the callback", async () => {
  const failure = new Error("writer failed");
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(failure));
    },
  });
  await expect(write(broken, "record\n")).rejects.toThrow("writer failed");
  const closed = new Writable({
    write() {
      this.destroy();
    },
  });
  await expect(write(closed, "record\n")).rejects.toThrow(/closed/);
});

test.skipIf(process.platform !== "linux")(
  "cancellation terminates a descendant after its parent closes",
  async () => {
    const controller = new AbortController();
    const descendant =
      'process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)';
    const parent = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","ignore","ignore","ipc"]});child.on("message",()=>{child.disconnect();process.stdout.write(String(child.pid));});setInterval(()=>{},1000);`;
    let pid: number | undefined;
    await runWithCleanup(
      async () => {
        const result = await processRun([process.execPath, "-e", parent], {
          cwd: process.cwd(),
          env: process.env,
          signal: controller.signal,
          output: async (_stream, text) => {
            pid = Number(text);
            controller.abort();
          },
        });
        expect(result.code).toBe(130);
        expect(pid).toBeGreaterThan(0);
        const stateOfChild = () =>
          readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          });
        let state = await stateOfChild();
        const deadline = Date.now() + 500;
        while (
          state !== "" &&
          !state.slice(state.lastIndexOf(")") + 2).startsWith("Z ") &&
          Date.now() < deadline
        ) {
          // eslint-disable-next-line no-await-in-loop -- Signal delivery precedes the process exit transition.
          await Bun.sleep(10);
          // eslint-disable-next-line no-await-in-loop -- Observe that same owned process after signal delivery.
          state = await stateOfChild();
        }
        expect(state === "" || state.slice(state.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
      },
      async () => {
        if (pid)
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
      },
    );
  },
);
