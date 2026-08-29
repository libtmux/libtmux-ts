import { spawn } from "node:child_process";
import { chmod, lstat, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { processExists, waitForPathAbsent, waitForProcessExit } from "../support/converge.js";
import { createRegisteredTestServer } from "../support/fixture_registry.js";
import {
  reservationsIn,
  waitForNoNewReservations,
  withTemporaryRunRoot,
} from "../support/run_root_harness.js";
import { reapRedLaunch } from "../support/tmux_cleanup.js";

import {
  prepareRunRoot,
  readFixtureRecord,
  reapOwnedRunRoot,
  type FixtureRecord,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeLaunchWrapper(
  parent: string,
  mode: "hold-after-launch" | "move-socket-after-launch" | "move-socket-and-hold",
  marker: string,
  recoverySocket?: string,
): Promise<string> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const wrapper = join(parent, `tmux-${mode}`);
  const afterLaunch =
    mode === "hold-after-launch"
      ? "while :; do sleep 30; done"
      : [
          `socket=$(printf '%s' "$output" | cut -f1)`,
          `session=$(printf '%s' "$output" | cut -f3)`,
          "attempt=0",
          "pane_command=",
          'while [ "$attempt" -lt 1000 ]; do',
          `  pane_command=$(${shellQuote(tmux)} -N -S "$socket" display-message -p -t "$session" '#{pane_current_command}')`,
          '  if [ "$pane_command" = cat ]; then break; fi',
          "  attempt=$((attempt + 1))",
          "done",
          'if [ "$pane_command" != cat ]; then exit 70; fi',
          `mv -- "$socket" ${shellQuote(recoverySocket ?? "")}`,
          ...(mode === "move-socket-and-hold" ? ["while :; do sleep 30; done"] : []),
        ].join("\n");
  await writeFile(
    wrapper,
    `#!/bin/sh
case " $* " in
  *" new-session "*)
    output=$(${shellQuote(tmux)} "$@")
    status=$?
    printf '%s\n' "$output"
    printf '%s\n' "$output" > ${shellQuote(marker)}
    ${afterLaunch}
    exit "$status"
    ;;
  *) exec ${shellQuote(tmux)} "$@" ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeNonzeroLaunchFrameWrapper(parent: string, marker: string): Promise<string> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const wrapper = join(parent, "tmux-nonzero-launch-frame");
  await writeFile(
    wrapper,
    `#!/bin/sh
case " $* " in
  *" new-session "*)
    output=$(${shellQuote(tmux)} "$@")
    printf '%s\n' "$output"
    printf '%s\n' "$output" > ${shellQuote(marker)}
    exit 7
    ;;
  *) exec ${shellQuote(tmux)} "$@" ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeGonePidLaunchWrapper(parent: string, exitedPid: number): Promise<string> {
  const wrapper = join(parent, "tmux-gone-launch-pid");
  await writeFile(
    wrapper,
    `#!/bin/sh
socket=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-S" ]; then
    shift
    socket=$1
  fi
  shift
done
printf '%s\\t${String(exitedPid)}\\t%s\\n' "$socket" '$42'
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeNoncanonicalPidLaunchWrapper(parent: string): Promise<string> {
  const wrapper = join(parent, "tmux-noncanonical-launch-pid");
  await writeFile(
    wrapper,
    `#!/bin/sh
socket=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-S" ]; then
    shift
    socket=$1
  fi
  shift
done
printf '%s\\t999999999junk\\t%s\\n' "$socket" '$42'
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

describe("TestServer launch recovery", () => {
  test("reaps an indeterminate delegated launch that times out after publishing its frame", async () => {
    const parent = await makeTestDirectory("ltx4-launch-timeout-");
    const runRoot = join(parent, "run");
    const marker = join(parent, "launch.frame");
    await prepareRunRoot(runRoot);
    const wrapper = await writeLaunchWrapper(parent, "hold-after-launch", marker);
    try {
      await expect(TestServer.create({ launchExecutable: wrapper, runRoot })).rejects.toThrow(
        /timed out|timeout/u,
      );
      const [socketPath, rawPid] = (await readFile(marker, "utf8")).trim().split("\t");
      await waitForProcessExit(Number(rawPid));
      await waitForPathAbsent(socketPath!);
      expect((await reapOwnedRunRoot(runRoot)).reservationsFound).toBe(0);
    } finally {
      try {
        const [socketPath] = (await readFile(marker, "utf8")).trim().split("\t");
        if (socketPath !== undefined) {
          await reapRedLaunch(socketPath);
          await rm(socketPath, { force: true });
        }
      } catch {
        // A pre-launch failure has no daemon to reap.
      }
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 10_000);

  test("preserves pre-authority evidence when the launch socket disappears", async () => {
    const parent = await makeTestDirectory("ltx4-launch-socket-loss-");
    const runRoot = join(parent, "run");
    const marker = join(parent, "launch.frame");
    const recoverySocket = join(parent, "recovery.sock");
    await prepareRunRoot(runRoot);
    const wrapper = await writeLaunchWrapper(
      parent,
      "move-socket-after-launch",
      marker,
      recoverySocket,
    );
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (sentinel.pid === undefined) throw new Error("sentinel has no PID");
    const sentinelClosed = new Promise<void>((resolve) => sentinel.once("close", () => resolve()));
    try {
      let failure: unknown;
      try {
        await TestServer.create({
          faultInjection: "after-launch",
          runRoot,
          launchExecutable: wrapper,
        });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("fixture socket is missing during generation validation");
      expect((failure as Error & { cleanupError?: unknown }).cleanupError).toBeDefined();
      const [socketPath, rawPid] = (await readFile(marker, "utf8")).trim().split("\t");
      expect(processExists(Number(rawPid))).toBe(true);
      expect(processExists(sentinel.pid)).toBe(true);
      await waitForPathAbsent(socketPath!);
      const reservations = (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
      expect(reservations).toHaveLength(1);
      expect((await readFixtureRecord(join(runRoot, reservations[0]!))).phase).toBe("launching");
    } finally {
      try {
        await reapRedLaunch(recoverySocket);
      } catch {
        // The authenticated cleanup may already have reaped the daemon.
      }
      await rm(recoverySocket, { force: true });
      if (processExists(sentinel.pid)) sentinel.kill("SIGKILL");
      await sentinelClosed;
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 10_000);

  test("preserves an indeterminate launch whose socket moved before authority", async () => {
    const parent = await makeTestDirectory("ltx4-launch-partial-timeout-");
    const runRoot = join(parent, "run");
    const marker = join(parent, "launch.frame");
    const recoverySocket = join(parent, "recovery.sock");
    await prepareRunRoot(runRoot);
    const wrapper = await writeLaunchWrapper(
      parent,
      "move-socket-and-hold",
      marker,
      recoverySocket,
    );
    try {
      await expect(TestServer.create({ launchExecutable: wrapper, runRoot })).rejects.toThrow(
        /timed out/u,
      );
      const [socketPath, rawPid] = (await readFile(marker, "utf8")).trim().split("\t");
      expect(processExists(Number(rawPid))).toBe(true);
      await waitForPathAbsent(socketPath!);
      const reservations = (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
      expect(reservations).toHaveLength(1);
      expect((await readFixtureRecord(join(runRoot, reservations[0]!))).phase).toBe("launching");
    } finally {
      await reapRedLaunch(recoverySocket).catch(() => undefined);
      await rm(recoverySocket, { force: true });
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 10_000);

  test("authenticates a valid launch frame from a nonzero result before cleanup", async () => {
    const parent = await makeTestDirectory("ltx4-nonzero-launch-frame-");
    const runRoot = join(parent, "run");
    const marker = join(parent, "launch.frame");
    await prepareRunRoot(runRoot);
    const before = new Set(await reservationsIn(runRoot));
    const wrapper = await writeNonzeroLaunchFrameWrapper(parent, marker);
    let primary: unknown;
    try {
      await TestServer.create({ launchExecutable: wrapper, runRoot });
    } catch (error) {
      primary = error;
    }
    try {
      expect(String(primary)).toContain("tmux bootstrap failed with status 7");
      expect((primary as Error & { cleanupError?: unknown }).cleanupError).toBeUndefined();
      const [socketPath, rawPid] = (await readFile(marker, "utf8")).trim().split("\t");
      await waitForProcessExit(Number(rawPid));
      await waitForPathAbsent(socketPath!);
      await waitForNoNewReservations(runRoot, before);
    } finally {
      try {
        const [socketPath] = (await readFile(marker, "utf8")).trim().split("\t");
        if (socketPath !== undefined) {
          await reapRedLaunch(socketPath).catch(() => undefined);
          await unlink(socketPath).catch(() => undefined);
        }
      } catch {
        // A pre-launch failure has no exact daemon or socket to reap.
      }
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 10_000);

  test("removes a partial atomic identity temp and recovers from the original launching record", async () => {
    await withTemporaryRunRoot("partial-record-write", async (runRoot) => {
      const before = new Set(await reservationsIn(runRoot));
      let unexpected: TestServer | undefined;
      try {
        unexpected = await TestServer.create({
          faultInjection: "partial-identity-record-write",
          runRoot,
        });
      } catch (error) {
        expect(String(error)).toContain("injected partial identity record write failure");
      }
      if (unexpected !== undefined) {
        await unexpected.dispose();
        throw new Error("expected injected partial identity record write failure");
      }
      await waitForNoNewReservations(runRoot, before);
    });
  });

  test("preserves a launching reservation when a parsed daemon PID is already gone", async () => {
    const parent = await makeTestDirectory("ltx4-gone-launch-pid-");
    const runRoot = join(parent, "run");
    await prepareRunRoot(runRoot);
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (exited.pid === undefined) throw new Error("short-lived child has no PID");
    await new Promise<void>((resolve) => exited.once("close", () => resolve()));
    const wrapper = await writeGonePidLaunchWrapper(parent, exited.pid);
    try {
      await expect(TestServer.create({ launchExecutable: wrapper, runRoot })).rejects.toThrow(
        "tmux daemon identity is missing after launch",
      );
      const reservations = (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
      expect(reservations).toHaveLength(1);
      expect((await readFixtureRecord(join(runRoot, reservations[0]!))).phase).toBe("launching");
    } finally {
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects a noncanonical launch PID before attempting recovery", async () => {
    const parent = await makeTestDirectory("ltx4-bad-launch-pid-");
    const runRoot = join(parent, "run");
    await prepareRunRoot(runRoot);
    const wrapper = await writeNoncanonicalPidLaunchWrapper(parent);
    try {
      await expect(TestServer.create({ launchExecutable: wrapper, runRoot })).rejects.toThrow(
        "invalid or mismatched socket identity",
      );
      const entries = (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
      expect(entries).toHaveLength(1);
      expect((await readFixtureRecord(join(runRoot, entries[0]!))).phase).toBe("launching");
    } finally {
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("reserves eight concurrent exact sockets and consumes pane readiness after signaling", async () => {
    await withTemporaryRunRoot("run, root with space", async (runRoot) => {
      const before = new Set(await reservationsIn(runRoot));
      const servers = await Promise.all(
        Array.from({ length: 8 }, () => createRegisteredTestServer({ runRoot })),
      );
      try {
        expect(new Set(servers.map((server) => server.logicalSocketName)).size).toBe(8);
        expect(new Set(servers.map((server) => server.socketPath)).size).toBe(8);

        await Promise.all(
          servers.map(async (server) => {
            expect(server.socketPath).toBe(join(runRoot, server.logicalSocketName, "s"));
            expect(server.observedSocketPath).toBe(server.socketPath);
            expect(server.readinessSignaledBeforeControllerWait).toBe(true);
            expect((await stat(server.reservationPath)).mode & 0o777).toBe(0o700);
            const result = await server.executeRaw([
              "display-message",
              "-p",
              "-t",
              server.sessionName,
              "#{socket_path}",
            ]);
            expect(new TextDecoder().decode(result.stdout).trim()).toBe(server.socketPath);
          }),
        );

        const first = servers[0]!;
        const cleanup = first.dispose();
        expect(first.dispose()).toBe(cleanup);
        await cleanup;
        await expect(stat(first.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await Promise.all(servers.map((server) => server.dispose()));
      }

      await waitForNoNewReservations(runRoot, before);
    });
  }, 20_000);

  test("enters an observed stable local pane hold before create resolves", async () => {
    await withTemporaryRunRoot("observed-readiness", async (runRoot) => {
      const server = await TestServer.create({ runRoot });
      try {
        const state = await server.executeText([
          "display-message",
          "-p",
          "-t",
          server.sessionId,
          "#{pane_current_command}",
        ]);
        expect(state.stdout).toEqual(["cat"]);
      } finally {
        await server.dispose();
      }
    });
  });

  test("publishes the authenticated Unix socket inode in a running fixture record", async () => {
    await withTemporaryRunRoot("durable-socket-identity", async (runRoot) => {
      const server = await TestServer.create({ runRoot });
      try {
        const record = (await readFixtureRecord(server.reservationPath)) as FixtureRecord & {
          readonly socketIdentity?: {
            readonly device: string;
            readonly inode: string;
            readonly kind: "socket";
            readonly mode: string;
            readonly uid: string;
          };
        };
        const socket = await lstat(server.socketPath);
        expect(record.socketIdentity).toEqual({
          device: String(socket.dev),
          inode: String(socket.ino),
          kind: "socket",
          mode: String(socket.mode),
          uid: String(socket.uid),
        });
      } finally {
        await server.dispose();
      }
    });
  });
});
