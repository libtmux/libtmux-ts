import {
  access,
  chmod,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { waitForProcessExit } from "../support/converge.js";
import { waitForOwnReservations, withTemporaryRunRoot } from "../support/run_root_harness.js";
import { reapRedLaunch } from "../support/tmux_cleanup.js";

import {
  prepareRunRoot,
  readFixtureRecord,
  reapOwnedRunRoot,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeExitStatusWrapper(parent: string, status: number): Promise<string> {
  const wrapper = join(parent, `tmux-exit-${String(status)}`);
  await writeFile(wrapper, `#!/bin/sh\nexit ${String(status)}\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeLoggingTmuxWrapper(parent: string, callLog: string): Promise<string> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const wrapper = join(parent, "tmux-call-log");
  await writeFile(
    wrapper,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(callLog)}
exec ${shellQuote(tmux)} "$@"
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

describe("TestServer cleanup", () => {
  for (const fault of [
    "after-launch",
    "identity-record-write",
    "after-identity-record",
    "before-readiness",
  ] as const) {
    test(`cleans socket, record, reservation, and daemon after ${fault} failure`, async () => {
      await withTemporaryRunRoot(`fault-${fault}`, async (runRoot) => {
        let unexpected: TestServer | undefined;
        try {
          unexpected = await TestServer.create({ runRoot, faultInjection: fault } as never);
        } catch (error) {
          expect(String(error)).toContain(`injected ${fault} failure`);
        }
        if (unexpected !== undefined) {
          await unexpected.dispose();
          throw new Error(`expected injected ${fault} failure`);
        }
        await waitForOwnReservations(runRoot);
      });
    });
  }

  test("preserves a body failure when fixture cleanup also reports a leak", async () => {
    const parent = await makeTestDirectory("ltx4-create-cleanup-primary-");
    const runRoot = join(parent, "root");
    await prepareRunRoot(runRoot);
    const primary = new Error("body failed before cleanup");
    let unexpected: string | undefined;
    try {
      let received: unknown;
      try {
        await TestServer.run({ runRoot }, async (server) => {
          unexpected = join(server.reservationPath, "unexpected");
          await writeFile(unexpected, "keep", { mode: 0o600 });
          throw primary;
        });
      } catch (error) {
        received = error;
      }
      expect(received).toBe(primary);
      expect(String((primary as Error & { cleanupError: unknown }).cleanupError)).toContain(
        "unexpected",
      );
    } finally {
      if (unexpected !== undefined) await unlink(unexpected).catch(() => undefined);
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("survives repeated immediate socket unlink cleanup after observed readiness", async () => {
    await withTemporaryRunRoot("unlink-stress", async (runRoot) => {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        // eslint-disable-next-line no-await-in-loop -- each fixture lifecycle is the stress subject.
        const server = await TestServer.create({ runRoot });
        // eslint-disable-next-line no-await-in-loop -- unlink is deliberately immediate after create resolves.
        await rm(server.socketPath);
        // eslint-disable-next-line no-await-in-loop -- exact cleanup must settle before the next lifecycle.
        await server.dispose();
        // eslint-disable-next-line no-await-in-loop -- every iteration proves its reservation is gone.
        await expect(access(server.reservationPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await waitForOwnReservations(runRoot);
    });
  }, 30_000);

  test("uses the authenticated daemon executable for the cleanup PID guard", async () => {
    const parent = await makeTestDirectory("ltx4-cleanup-executable-");
    const runRoot = join(parent, "root");
    const callLog = join(parent, "tmux-calls.log");
    await prepareRunRoot(runRoot);
    const wrapper = await writeLoggingTmuxWrapper(parent, callLog);
    let server: TestServer | undefined;
    try {
      server = await TestServer.create({ launchExecutable: wrapper, runRoot });
      const startupCalls = await readFile(callLog, "utf8");
      expect(startupCalls).toContain("new-session");

      await server.dispose();
      server = undefined;

      expect(await readFile(callLog, "utf8")).toBe(startupCalls);
    } finally {
      await server?.dispose().catch(() => undefined);
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  for (const mutation of ["add-unexpected", "replace-socket"] as const) {
    test(`preserves cleanup evidence after ${mutation}`, async () => {
      const parent = await makeTestDirectory("ltx4-cleanup-mutation-");
      const runRoot = join(parent, "root");
      const recoverySocket = join(parent, "recovery.sock");
      await prepareRunRoot(runRoot);
      const server = await TestServer.create({ runRoot });
      try {
        if (mutation === "add-unexpected") {
          await writeFile(join(server.reservationPath, "unexpected"), "keep", { mode: 0o600 });
        } else {
          await rename(server.socketPath, recoverySocket);
          await writeFile(server.socketPath, "replacement", { mode: 0o600 });
        }
        await expect(server.dispose()).rejects.toThrow();
        expect((await stat(server.recordPath)).isFile()).toBe(true);
        if (mutation === "add-unexpected") {
          expect(await readFile(join(server.reservationPath, "unexpected"), "utf8")).toBe("keep");
          expect((await stat(server.socketPath)).isSocket()).toBe(true);
        } else {
          expect((await stat(server.socketPath)).isFile()).toBe(true);
          expect(await readFile(server.socketPath, "utf8")).toBe("replacement");
        }
      } finally {
        await unlink(join(server.reservationPath, "unexpected")).catch(() => undefined);
        const socket = await stat(server.socketPath).catch(() => undefined);
        if (socket?.isFile() === true) await unlink(server.socketPath);
        if ((await stat(recoverySocket).catch(() => undefined))?.isSocket() === true) {
          await rename(recoverySocket, server.socketPath);
        }
        await reapOwnedRunRoot(runRoot).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    });
  }

  test("accepts authenticated socket disappearance after the daemon exits", async () => {
    const parent = await makeTestDirectory("ltx4-cleanup-socket-move-");
    const runRoot = join(parent, "root");
    const movedSocket = join(parent, "moved-socket");
    await prepareRunRoot(runRoot);
    const server = await TestServer.create({ runRoot });
    try {
      await reapRedLaunch(server.socketPath);
      await waitForProcessExit(server.daemonIdentity.pid);
      await rename(server.socketPath, movedSocket);
      await server.dispose();
      await expect(stat(server.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(movedSocket)).isSocket()).toBe(true);
    } finally {
      await unlink(movedSocket).catch(() => undefined);
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("cleans a failed startup without a daemon, registry, socket, or reservation", async () => {
    await withTemporaryRunRoot("startup-failure", async (runRoot) => {
      await expect(
        TestServer.create({
          runRoot,
          launchExecutable: join(runRoot, "missing-tmux"),
        }),
      ).rejects.toThrow();

      await waitForOwnReservations(runRoot);
    });
  });

  for (const status of [1, 7]) {
    test(`preserves a pre-authority launch failure with status ${String(status)}`, async () => {
      const parent = await makeTestDirectory("ltx4-launch-status-");
      const runRoot = join(parent, "run");
      await prepareRunRoot(runRoot);
      const wrapper = await writeExitStatusWrapper(parent, status);
      try {
        let failure: unknown;
        try {
          await TestServer.create({ launchExecutable: wrapper, runRoot });
        } catch (error) {
          failure = error;
        }
        expect(String(failure)).toContain(`status ${String(status)}`);
        expect((failure as Error & { cleanupError?: unknown }).cleanupError).toBeDefined();
        const reservations = (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
        expect(reservations).toHaveLength(1);
        expect((await readFixtureRecord(join(runRoot, reservations[0]!))).phase).toBe("launching");
      } finally {
        await reapOwnedRunRoot(runRoot).catch(() => undefined);
        await rm(parent, { force: true, recursive: true });
      }
    });
  }

  test("cleans the fixture when its test body throws", async () => {
    await withTemporaryRunRoot("throwing-body", async (runRoot) => {
      const primary = new Error("primary test failure");
      await expect(
        TestServer.run({ runRoot }, async () => {
          throw primary;
        }),
      ).rejects.toBe(primary);

      await waitForOwnReservations(runRoot);
    });
  });

  test("rejects an overlong Unix socket path before attempting tmux spawn", async () => {
    const parent = await makeTestDirectory("ltx4-long-");
    const runRoot = join(parent, "x".repeat(120));
    await prepareRunRoot(runRoot);
    try {
      await expect(
        TestServer.create({
          runRoot,
          launchExecutable: join(runRoot, "also-missing"),
        }),
      ).rejects.toThrow("Unix socket path");
      expect(await readFile(join(runRoot, ".owner.json"), "utf8")).toContain("libtmux-test-run-v2");
      expect((await reapOwnedRunRoot(runRoot)).reservationsFound).toBe(0);
    } finally {
      await reapOwnedRunRoot(runRoot);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("measures the conservative socket limit in UTF-8 bytes before spawn", async () => {
    const parent = await makeTestDirectory("ltx4-byte-limit-");
    const runRoot = join(parent, "雪".repeat(40));
    await prepareRunRoot(runRoot);
    try {
      await expect(
        TestServer.create({
          runRoot,
          launchExecutable: join(runRoot, "missing-tmux"),
        }),
      ).rejects.toThrow("103 UTF-8 bytes");
      expect((await reapOwnedRunRoot(runRoot)).reservationsFound).toBe(0);
    } finally {
      await reapOwnedRunRoot(runRoot);
      await rm(parent, { force: true, recursive: true });
    }
  });
});
