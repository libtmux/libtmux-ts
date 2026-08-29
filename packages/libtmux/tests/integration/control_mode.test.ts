import {
  CONTROL_REGISTRATION_DEADLINE_MS,
  deadlineMs,
  ControlMode,
  readFixtureRecord,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";
import { ChildProcess, spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

import { closeChildWithin, waitForPathPresent } from "../support/converge.js";
import { parseNullFrames } from "../support/launch_frame.js";
import { withTemporaryRunRoot } from "../support/run_root_harness.js";

import { createRegisteredTestServer } from "../support/fixture_registry.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeControlTimerProbe(
  parent: string,
  mode: "dispose" | "partial-open",
  marker: string,
): Promise<string> {
  const testkitModule = pathToFileURL(
    fileURLToPath(new URL("../../src/_internal/test/testkit.ts", import.meta.url)),
  ).href;
  const script = join(parent, `control-timer-${mode}.ts`);
  const wrapper = join(parent, "ignore-control-term.sh");
  const assertedMarker = join(parent, "control-controller-asserted");
  const registrationMarker = join(parent, "control-registration-probed");
  const spawnedMarker = join(parent, "control-child-spawned");
  await writeFile(
    wrapper,
    `#!/bin/sh\nprintf spawned > ${shellQuote(spawnedMarker)}\ntrap '' TERM\nwhile :; do sleep 30; done\n`,
    { mode: 0o700 },
  );
  const body =
    mode === "partial-open"
      ? `const fakeServer = {
  assertControllerCurrent: async () => writeFile(${JSON.stringify(assertedMarker)}, "asserted"),
  controllerEnvironment: Object.freeze({ ...process.env }),
  executeText: async () => {
    await writeFile(${JSON.stringify(registrationMarker)}, "probed");
    return new Promise(() => undefined);
  },
  socketPath: "/does/not/matter",
  tmuxExecutable: ${JSON.stringify(wrapper)},
};
let openError: unknown;
try {
  await ControlMode.open({ server: fakeServer, targetSession: "$0" });
} catch (error) {
  openError = error;
}
if (!(openError instanceof Error) || !openError.message.includes("registration timed out")) {
  throw new Error("partial ControlMode open did not reach its registration deadline");
}`
      : `const runRoot = ${JSON.stringify(join(parent, "timer-run"))};
await prepareRunRoot(runRoot);
const server = await TestServer.create({ runRoot });
const control = await ControlMode.open({ server, targetSession: server.sessionId });
await control.dispose();
await server.dispose();
await reapOwnedRunRoot(runRoot);`;
  await writeFile(
    script,
    `import { writeFile } from "node:fs/promises";
import { ControlMode, prepareRunRoot, reapOwnedRunRoot, TestServer } from ${JSON.stringify(testkitModule)};
${body}
await writeFile(${JSON.stringify(marker)}, "done");
`,
  );
  return script;
}

async function waitForControlProbe(path: string): Promise<void> {
  const timeoutMs = deadlineMs(CONTROL_REGISTRATION_DEADLINE_MS) * 4 + deadlineMs(2_000);
  await waitForPathPresent(path, timeoutMs);
}

describe("ControlMode", () => {
  test("keeps ControlMode as an attached client resource", async () => {
    await withTemporaryRunRoot("control-mode", async (runRoot) => {
      const server = await createRegisteredTestServer({ runRoot });
      const control = await ControlMode.open({ server, targetSession: server.sessionId });
      try {
        const listed = await server.executeText([
          "list-clients",
          "-F",
          "#{client_pid}\t#{client_name}",
        ]);
        expect(listed.stdout).toContain(`${String(control.pid)}\t${control.clientName}`);
      } finally {
        await control.dispose();
        const listed = await server.executeText(["list-clients", "-F", "#{client_pid}"]);
        expect(listed.stdout).not.toContain(String(control.pid));
        await server.dispose();
      }
    });
  });

  test("starts ControlMode from the frozen base environment without the daemon generation", async () => {
    await withTemporaryRunRoot("control-environment", async (runRoot) => {
      const environment = { ...process.env, LIBTMUX_CONTROL_BASE: "entry" };
      const server = await createRegisteredTestServer({ environment, runRoot });
      environment.LIBTMUX_CONTROL_BASE = "mutated";
      const record = await readFixtureRecord(server.reservationPath);
      if (record.phase !== "running") throw new Error("fixture did not publish running authority");
      const control = await ControlMode.open({ server, targetSession: server.sessionId });
      try {
        const frames = parseNullFrames(await readFile(`/proc/${String(control.pid)}/environ`));
        expect(frames.filter((frame) => frame.startsWith("LIBTMUX_CONTROL_BASE="))).toEqual([
          "LIBTMUX_CONTROL_BASE=entry",
        ]);
        expect(frames.some((frame) => frame.startsWith(`${record.generation.name}=`))).toBe(false);
      } finally {
        await control.dispose();
        await server.dispose();
      }
    });
  });

  test("owns only its exact attached client and drains non-ASCII control output", async () => {
    await withTemporaryRunRoot("two-control-clients", async (runRoot) => {
      const server = await createRegisteredTestServer({ runRoot });
      const first = await ControlMode.open({ server, targetSession: server.sessionId });
      const second = await ControlMode.open({ server, targetSession: server.sessionId });
      try {
        expect(first.clientName).not.toBe(second.clientName);
        expect(
          await first.sendAndWaitFor("display-message -p '雪'", (line) => line.includes("雪")),
        ).toContain("雪");
        await first.dispose();
        const listed = await server.executeText([
          "list-clients",
          "-F",
          "#{client_pid}\t#{client_name}",
        ]);
        expect(listed.stdout).not.toContain(`${String(first.pid)}\t${first.clientName}`);
        expect(listed.stdout).toContain(`${String(second.pid)}\t${second.clientName}`);
      } finally {
        await Promise.all([first.dispose(), second.dispose()]);
        await server.dispose();
      }
    });
  });

  test("submits every ControlMode line and correlates predicates after a watermark", async () => {
    await withTemporaryRunRoot("control-watermark", async (runRoot) => {
      const server = await createRegisteredTestServer({ runRoot });
      const control = await ControlMode.open({ server, targetSession: server.sessionId });
      try {
        const first = await control.sendAndWaitFor(
          "display-message -p 'same-predicate:first'",
          (line) => line.includes("same-predicate:"),
        );
        const second = await control.sendAndWaitFor(
          "display-message -p 'same-predicate:second'",
          (line) => line.includes("same-predicate:"),
        );
        expect(first).toContain("same-predicate:first");
        expect(second).toContain("same-predicate:second");
      } finally {
        await control.dispose();
        await server.dispose();
      }
    });
  });

  test("settles a missing ControlMode executable within a hard deadline", async () => {
    let controllerAssertionRan = false;
    const fakeServer = {
      assertControllerCurrent: async () => {
        controllerAssertionRan = true;
      },
      controllerEnvironment: Object.freeze({}),
      executeText: async () => ({ stderr: [], stdout: [] }),
      socketPath: "/does/not/exist/s",
      tmuxExecutable: "/does/not/exist/tmux",
    };
    const originalEmit = ChildProcess.prototype.emit;
    let spawnError: { readonly code?: string; readonly path?: string } | undefined;
    ChildProcess.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
      if (event === "error" && this.spawnfile === fakeServer.tmuxExecutable) {
        spawnError = args[0] as typeof spawnError;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
    };
    const started = performance.now();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          ControlMode.open({ server: fakeServer as never, targetSession: "$0" }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("ControlMode open exceeded hard deadline")),
              1_000,
            );
          }),
        ]),
      ).rejects.toThrow("control-mode client did not spawn");
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      ChildProcess.prototype.emit = originalEmit;
    }
    expect(controllerAssertionRan).toBeTrue();
    expect(spawnError?.code).toBe("ENOENT");
    expect(spawnError?.path).toBe(fakeServer.tmuxExecutable);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("bounds ControlMode registration when the server probe never settles", async () => {
    await withTemporaryRunRoot("control-never-settles", async (runRoot) => {
      const server = await TestServer.create({ runRoot });
      const executeText = server.executeText.bind(server);
      let releaseProbe: (() => void) | undefined;
      server.executeText = async () =>
        new Promise((resolve) => {
          releaseProbe = () => resolve({ stderr: [], stdout: [] });
        });
      const opening = ControlMode.open({ server, targetSession: server.sessionId });
      try {
        // Both bounds follow the deadline being tested rather than repeating a
        // number derived from it: the race has to lose to ControlMode's own
        // deadline, and the elapsed time has to show that deadline is what
        // ended it rather than something slower.
        const registration = deadlineMs(CONTROL_REGISTRATION_DEADLINE_MS);
        const started = performance.now();
        await expect(
          Promise.race([
            opening,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("registration exceeded wall-clock deadline")),
                registration * 3,
              ),
            ),
          ]),
        ).rejects.toThrow(/registration timed out/u);
        expect(performance.now() - started).toBeLessThan(registration * 2);
      } finally {
        releaseProbe?.();
        server.executeText = executeText;
        await opening.then((control) => control.dispose()).catch(() => undefined);
        const clients = await server.executeText(["list-clients", "-F", "#{client_pid}"]);
        await Promise.all(
          clients.stdout.map(async (pid) => server.executeText(["kill-client", "-t", pid])),
        );
        await server.dispose();
      }
    });
    // The race below waits three registration deadlines, so the budget has to
    // outlast that window rather than cut it short.
  }, 30_000);

  test("cleans a partially attached ControlMode and a throwing body", async () => {
    await withTemporaryRunRoot("control-failure", async (runRoot) => {
      const server = await createRegisteredTestServer({ runRoot });
      await expect(
        ControlMode.open({ server, targetSession: "missing-session" }),
      ).rejects.toThrow();
      const primary = new Error("attached body failed");
      await expect(
        ControlMode.run({ server, targetSession: server.sessionId }, async () => {
          throw primary;
        }),
      ).rejects.toBe(primary);
      expect((await server.executeText(["list-clients", "-F", "#{client_pid}"])).stdout).toEqual(
        [],
      );
      await server.dispose();
    });
  });

  for (const mode of ["partial-open", "dispose"] as const) {
    test(`does not retain a Bun process through a losing ControlMode ${mode} timer`, async () => {
      const parent = await makeTestDirectory(`ltx4-control-timer-${mode}-`);
      const marker = join(parent, "done");
      const script = await writeControlTimerProbe(parent, mode, marker);
      const child = spawn("bun", [script], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      try {
        await waitForControlProbe(marker);
        if (mode === "partial-open") {
          await access(join(parent, "control-controller-asserted"));
          await access(join(parent, "control-registration-probed"));
          await access(join(parent, "control-child-spawned"));
        }
        const completedAt = performance.now();
        // A leaked timer would hold the process for the registration deadline,
        // so exiting well inside that window is what proves nothing retained
        // it. The bound is far enough below the deadline that a busy machine
        // cannot decide the outcome, and far enough under it to still mean
        // something.
        const bound = Math.floor(deadlineMs(CONTROL_REGISTRATION_DEADLINE_MS) / 2);
        const closed = await closeChildWithin(child, bound);
        expect(closed).toEqual({ code: 0, signal: null });
        expect(performance.now() - completedAt).toBeLessThan(bound);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("close", () => resolve());
        });
        await rm(parent, { force: true, recursive: true });
      }
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    }, 30_000);
  }
});
