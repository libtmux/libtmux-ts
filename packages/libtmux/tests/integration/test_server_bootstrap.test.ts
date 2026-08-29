import { lstatSync, readFileSync } from "node:fs";
import { chmod, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { processExists, waitForPathPresent } from "../support/converge.js";
import { parseNullFrames } from "../support/launch_frame.js";
import { withTemporaryRunRoot } from "../support/run_root_harness.js";
import {
  captureTmuxCleanup,
  terminateCapturedTmux,
  type CapturedTmuxCleanup,
} from "../support/tmux_cleanup.js";

import {
  prepareRunRoot,
  readFixtureRecord,
  reapOwnedRunRoot,
  TestServer,
  type TestServerRequestSnapshot,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeBootstrapBarrierWrapper(
  parent: string,
  entered: string,
  argumentLog: string,
  environmentLog: string,
  releasePipe: string,
): Promise<string> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const wrapper = join(parent, "tmux-bootstrap-barrier");
  await writeFile(
    wrapper,
    `#!/bin/sh
for argument in "$@"; do printf '%s\\0' "$argument"; done > ${shellQuote(argumentLog)}
env | sed -n '/^LIBTMUX_TEST_GENERATION_/p' > ${shellQuote(environmentLog)}
printf 'entered\n' > ${shellQuote(entered)}
IFS= read -r _ < ${shellQuote(releasePipe)}
exec ${shellQuote(tmux)} "$@"
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function writeSnapshotLaunchWrapper(
  parent: string,
  entered: string,
  argumentLog: string,
  environmentLog: string,
  releasePipe: string,
): Promise<string> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const wrapper = join(parent, "tmux-snapshot-launch");
  await writeFile(
    wrapper,
    `#!/bin/sh
for argument in "$@"; do printf '%s\\0' "$argument"; done > ${shellQuote(argumentLog)}
{
  printf 'BASE=%s\n' "\${LIBTMUX_ENTRY_SNAPSHOT-unset}"
  env | sed -n '/^LIBTMUX_TEST_GENERATION_/p'
} > ${shellQuote(environmentLog)}
printf 'entered\n' > ${shellQuote(entered)}
IFS= read -r _ < ${shellQuote(releasePipe)}
exec ${shellQuote(tmux)} "$@"
`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function runTmux(args: readonly string[]): Promise<{
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const tmux = Bun.which("tmux");
  if (tmux === null) throw new Error("tmux is required");
  const child = Bun.spawn([tmux, ...args], { stderr: "pipe", stdout: "pipe" });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { code, stderr, stdout };
}

describe("TestServer bootstrap", () => {
  test("publishes owner v2 and a closed running fixture v3 record", async () => {
    const parent = await makeTestDirectory("ltx4-generation-schema-");
    const runRoot = join(parent, "root");
    await prepareRunRoot(runRoot);
    let server: TestServer | undefined;
    try {
      const owner = JSON.parse(await readFile(join(runRoot, ".owner.json"), "utf8")) as {
        controller?: {
          executablePath?: string;
          fileIdentity?: { kind?: string };
        };
        protocol?: string;
      };
      expect(owner.protocol).toBe("libtmux-test-run-v2");
      expect(owner.controller?.executablePath).toBeString();
      expect(owner.controller?.fileIdentity?.kind).toBe("file");

      server = await TestServer.create({ runRoot });
      const record = JSON.parse(await readFile(server.recordPath, "utf8")) as {
        bootstrapArgv?: readonly string[];
        controller?: unknown;
        daemon?: unknown;
        generation?: { name?: string; value?: string };
        phase?: string;
        protocol?: string;
        socketIdentity?: unknown;
      };
      expect(record.protocol).toBe("libtmux-test-fixture-v3");
      expect(record.phase).toBe("running");
      expect(record.controller).toEqual(owner.controller);
      expect(record.generation?.name).toMatch(/^LIBTMUX_TEST_GENERATION_[A-F0-9]{32}$/u);
      expect(record.generation?.value).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
      expect(record.bootstrapArgv).toBeArray();
      expect(record.daemon).toBeDefined();
      expect(record.socketIdentity).toBeDefined();
    } finally {
      await server?.dispose().catch(() => undefined);
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("snapshots entry inputs and authenticates the complete generated bootstrap", async () => {
    const parent = await makeTestDirectory("ltx4-generation-bootstrap-");
    const runRoot = join(parent, "root");
    const entered = join(parent, "entered");
    const argumentLog = join(parent, "bootstrap.argv");
    const environmentLog = join(parent, "bootstrap.env");
    const releasePipe = join(parent, "release.fifo");
    const observedRequests: TestServerRequestSnapshot[] = [];
    let replacementObserverCalled = false;
    let preTransport:
      | {
          readonly entry: { readonly device: bigint; readonly inode: bigint };
          readonly record: {
            readonly bootstrapArgv: readonly string[];
            readonly controller: { readonly executablePath: string };
            readonly generation: { readonly name: string; readonly value: string };
          };
          readonly recordBytes: string;
          readonly recordPath: string;
          readonly request: TestServerRequestSnapshot;
        }
      | undefined;
    await prepareRunRoot(runRoot);
    expect(await Bun.spawn(["mkfifo", releasePipe]).exited).toBe(0);
    const wrapper = await writeSnapshotLaunchWrapper(
      parent,
      entered,
      argumentLog,
      environmentLog,
      releasePipe,
    );
    const requestObserver = (request: TestServerRequestSnapshot): void => {
      if (
        !Object.isFrozen(request) ||
        !Object.isFrozen(request.args) ||
        !Object.isFrozen(request.environment)
      ) {
        throw new Error("request observer received a mutable execution snapshot");
      }
      observedRequests.push(request);
      if (request.purpose !== "bootstrap") return;
      if (preTransport !== undefined) throw new Error("bootstrap request was observed twice");
      const selectorIndexes = request.args.flatMap((argument, index) =>
        argument === "-S" ? [index] : [],
      );
      if (selectorIndexes.length !== 1) throw new Error("bootstrap has an invalid socket selector");
      const socketPath = request.args[selectorIndexes[0]! + 1];
      if (socketPath === undefined) throw new Error("bootstrap socket selector has no value");
      const recordPath = join(dirname(socketPath), "fixture.json");
      const recordBytes = readFileSync(recordPath, "utf8");
      const record = JSON.parse(recordBytes) as {
        bootstrapArgv?: readonly string[];
        controller?: { executablePath?: string };
        daemon?: unknown;
        generation?: { name?: string; value?: string };
        phase?: string;
        protocol?: string;
        socketIdentity?: unknown;
        socketPath?: string;
      };
      const entry = lstatSync(recordPath, { bigint: true });
      if (
        record.protocol !== "libtmux-test-fixture-v3" ||
        record.phase !== "launching" ||
        record.socketPath !== socketPath ||
        record.controller?.executablePath === undefined ||
        record.generation?.name === undefined ||
        record.generation.value === undefined ||
        record.bootstrapArgv === undefined ||
        record.daemon !== undefined ||
        record.socketIdentity !== undefined ||
        request.executable !== wrapper ||
        record.controller.executablePath === wrapper ||
        !entry.isFile() ||
        (entry.mode & 0o777n) !== 0o600n ||
        JSON.stringify(record.bootstrapArgv.slice(1)) !== JSON.stringify(request.args) ||
        record.bootstrapArgv[0] !== record.controller.executablePath ||
        request.environment[record.generation.name] !== record.generation.value
      ) {
        throw new Error("bootstrap was observed before complete launching evidence was durable");
      }
      preTransport = {
        entry: { device: entry.dev, inode: entry.ino },
        record: {
          bootstrapArgv: record.bootstrapArgv,
          controller: { executablePath: record.controller.executablePath },
          generation: { name: record.generation.name, value: record.generation.value },
        },
        recordBytes,
        recordPath,
        request,
      };
    };
    const environment = { ...process.env, LIBTMUX_ENTRY_SNAPSHOT: "before" };
    const options = {
      environment,
      launchExecutable: wrapper,
      requestObserver,
      runRoot,
    };
    const creating = TestServer.create(options);
    environment.LIBTMUX_ENTRY_SNAPSHOT = "after";
    options.launchExecutable = join(parent, "missing-after-entry");
    options.requestObserver = () => {
      replacementObserverCalled = true;
    };
    let server: TestServer | undefined;
    let launchEntered = false;
    let launchReleased = false;
    try {
      const launchBoundary = await Promise.race([
        creating.then((created) => ({ created, kind: "created" as const })),
        waitForPathPresent(entered).then(() => ({ kind: "entered" as const })),
      ]);
      if (launchBoundary.kind === "created") server = launchBoundary.created;
      launchEntered = launchBoundary.kind === "entered";
      expect(launchBoundary.kind).toBe("entered");
      if (preTransport === undefined) {
        throw new Error("bootstrap request was not observed before transport delivery");
      }
      const launchEvidence = preTransport;
      expect(parseNullFrames(await readFile(argumentLog))).toEqual(
        launchEvidence.record.bootstrapArgv.slice(1),
      );
      expect(await readFile(environmentLog, "utf8")).toBe(
        `BASE=before\n${launchEvidence.record.generation.name}=${launchEvidence.record.generation.value}\n`,
      );
      expect(await readFile(launchEvidence.recordPath, "utf8")).toBe(launchEvidence.recordBytes);
      const postSpawnEntry = await lstat(launchEvidence.recordPath, { bigint: true });
      expect({ device: postSpawnEntry.dev, inode: postSpawnEntry.ino }).toEqual(
        launchEvidence.entry,
      );
      await writeFile(releasePipe, "continue\n");
      launchReleased = true;
      server = await creating;
      expect(observedRequests.length).toBeGreaterThan(0);
      expect(replacementObserverCalled).toBe(false);
      expect(observedRequests.every((request) => Object.isFrozen(request))).toBe(true);
      expect(observedRequests.every((request) => Object.isFrozen(request.args))).toBe(true);
      expect(observedRequests.every((request) => Object.isFrozen(request.environment))).toBe(true);
      const record = JSON.parse(await readFile(server.recordPath, "utf8")) as {
        bootstrapArgv: readonly string[];
        daemon: { pid: number };
        generation: { name: string; value: string };
        protocol: string;
      };
      expect(record.protocol).toBe("libtmux-test-fixture-v3");
      expect(record.bootstrapArgv.slice(1, 8)).toEqual([
        "-f",
        "/dev/null",
        "-S",
        server.socketPath,
        "start-server",
        ";",
        "if-shell",
      ]);
      expect(record.bootstrapArgv.filter((argument) => argument === ";")).toEqual([";"]);
      expect(record.bootstrapArgv.some((argument) => argument.startsWith("new-session "))).toBe(
        true,
      );
      expect(parseNullFrames(await readFile(`/proc/${String(record.daemon.pid)}/cmdline`))).toEqual(
        record.bootstrapArgv,
      );

      const processGeneration = parseNullFrames(
        await readFile(`/proc/${String(record.daemon.pid)}/environ`),
      ).filter((entry) => entry.startsWith(`${record.generation.name}=`));
      expect(processGeneration).toEqual([`${record.generation.name}=${record.generation.value}`]);
      const globalGeneration = await server.executeRaw([
        "show-environment",
        "-g",
        record.generation.name,
      ]);
      expect(globalGeneration.returncode).toBe(0);
      expect(new TextDecoder().decode(globalGeneration.stdout)).toBe(
        `${record.generation.name}=${record.generation.value}\n`,
      );
      const ordinary = await server.executeRaw([
        "display-message",
        "-p",
        "ordinary-generation-environment-probe",
      ]);
      expect(ordinary.returncode).toBe(0);
      expect(new TextDecoder().decode(ordinary.stdout)).toBe(
        "ordinary-generation-environment-probe\n",
      );

      const bootstrapRequests = observedRequests.filter(({ purpose }) => purpose === "bootstrap");
      expect(bootstrapRequests).toHaveLength(1);
      expect(bootstrapRequests[0]?.environment[record.generation.name]).toBe(
        record.generation.value,
      );
      expect(observedRequests.some(({ purpose }) => purpose === "validation")).toBe(true);
      expect(observedRequests.some(({ purpose }) => purpose === "readiness")).toBe(true);
      expect(observedRequests.some(({ purpose }) => purpose === "ordinary")).toBe(true);
      expect(
        observedRequests.every(
          ({ environment: requestEnvironment }) =>
            requestEnvironment.LIBTMUX_ENTRY_SNAPSHOT === "before",
        ),
      ).toBe(true);
      expect(
        observedRequests
          .filter(({ purpose }) => purpose !== "bootstrap")
          .every(
            ({ environment: requestEnvironment }) =>
              Object.hasOwn(requestEnvironment, record.generation.name) === false,
          ),
      ).toBe(true);
    } finally {
      if (launchEntered && !launchReleased) await writeFile(releasePipe, "continue\n");
      try {
        server ??= await creating;
      } catch {
        // The rejected create promise is fully observed before fixture cleanup.
      }
      await server?.dispose().catch(() => undefined);
      await reapOwnedRunRoot(runRoot).catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("rejects a foreign daemon that wins the socket before bootstrap mutation", async () => {
    const parent = await makeTestDirectory("ltx4-generation-winner-");
    const runRoot = join(parent, "root");
    const entered = join(parent, "entered");
    const argumentLog = join(parent, "bootstrap.argv");
    const environmentLog = join(parent, "bootstrap.env");
    const releasePipe = join(parent, "release.fifo");
    await prepareRunRoot(runRoot);
    expect(await Bun.spawn(["mkfifo", releasePipe]).exited).toBe(0);
    const wrapper = await writeBootstrapBarrierWrapper(
      parent,
      entered,
      argumentLog,
      environmentLog,
      releasePipe,
    );
    const creating = TestServer.create({ launchExecutable: wrapper, runRoot });
    let created: TestServer | undefined;
    let captured: CapturedTmuxCleanup | undefined;
    let foreignPid: number | undefined;
    let launchEntered = false;
    let launchReleased = false;
    let socketPath: string | undefined;
    try {
      const launchBoundary = await Promise.race([
        creating.then((server) => ({ kind: "created" as const, server })),
        waitForPathPresent(entered).then(() => ({ kind: "entered" as const })),
      ]);
      if (launchBoundary.kind === "created") created = launchBoundary.server;
      launchEntered = launchBoundary.kind === "entered";
      expect(launchBoundary.kind).toBe("entered");
      const reservations = (await readdir(runRoot)).filter((entry) => entry !== ".owner.json");
      expect(reservations).toHaveLength(1);
      const reservationPath = join(runRoot, reservations[0]!);
      socketPath = join(reservationPath, "s");
      const recordPath = join(reservationPath, "fixture.json");
      const launchingBytes = await readFile(recordPath, "utf8");
      const launchingEntry = await lstat(recordPath, { bigint: true });
      const launching = JSON.parse(launchingBytes) as {
        bootstrapArgv: readonly string[];
        controller: unknown;
        daemon?: unknown;
        generation: { name: string; value: string };
        phase: string;
        protocol: string;
        socketIdentity?: unknown;
      };
      const owner = JSON.parse(await readFile(join(runRoot, ".owner.json"), "utf8")) as {
        controller: unknown;
      };
      expect(launching.protocol).toBe("libtmux-test-fixture-v3");
      expect(launching.phase).toBe("launching");
      expect(launching.controller).toEqual(owner.controller);
      expect(launching.daemon).toBeUndefined();
      expect(launching.socketIdentity).toBeUndefined();
      expect(parseNullFrames(await readFile(argumentLog))).toEqual(
        launching.bootstrapArgv.slice(1),
      );
      expect(await readFile(environmentLog, "utf8")).toBe(
        `${launching.generation.name}=${launching.generation.value}\n`,
      );

      const foreign = await runTmux([
        "-f",
        "/dev/null",
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pid}",
        "-s",
        "foreign",
        "exec cat",
      ]);
      expect(foreign.code).toBe(0);
      foreignPid = Number(foreign.stdout.trim());
      const socketBefore = await lstat(socketPath);
      captured = await captureTmuxCleanup(
        foreignPid,
        socketPath,
        join(parent, "foreign-recovery.sock"),
      );
      const generationBefore = await runTmux([
        "-N",
        "-S",
        socketPath,
        "show-environment",
        "-g",
        launching.generation.name,
      ]);
      expect(generationBefore.code).not.toBe(0);
      expect(generationBefore.stdout).toBe("");
      await writeFile(releasePipe, "continue\n");
      launchReleased = true;

      let failure: unknown;
      try {
        created = await creating;
      } catch (error) {
        failure = error;
      }
      expect(created).toBeUndefined();
      expect(processExists(foreignPid)).toBe(true);
      const sessions = await runTmux([
        "-N",
        "-S",
        socketPath,
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      expect(sessions.code).toBe(0);
      expect(sessions.stdout.trim().split("\n")).toEqual(["foreign"]);
      const socketAfter = await lstat(socketPath);
      expect({ dev: socketAfter.dev, ino: socketAfter.ino }).toEqual({
        dev: socketBefore.dev,
        ino: socketBefore.ino,
      });
      expect(await readFile(recordPath, "utf8")).toBe(launchingBytes);
      const recordAfter = await lstat(recordPath, { bigint: true });
      expect({
        device: recordAfter.dev,
        inode: recordAfter.ino,
        mode: recordAfter.mode,
        uid: recordAfter.uid,
      }).toEqual({
        device: launchingEntry.dev,
        inode: launchingEntry.ino,
        mode: launchingEntry.mode,
        uid: launchingEntry.uid,
      });
      const generationAfter = await runTmux([
        "-N",
        "-S",
        socketPath,
        "show-environment",
        "-g",
        launching.generation.name,
      ]);
      expect(generationAfter.code).not.toBe(0);
      expect(generationAfter.stdout).toBe("");
      expect(String(failure)).toContain("generation mismatch");
    } finally {
      if (launchEntered && !launchReleased) {
        await writeFile(releasePipe, "continue\n");
      }
      try {
        created ??= await creating;
      } catch {
        // The rejected create promise is fully observed before fixture cleanup.
      }
      if (captured !== undefined) await terminateCapturedTmux(captured);
      await created?.dispose().catch(() => undefined);
      await rm(parent, { force: true, recursive: true });
    }
  }, 10_000);
  test("rejects a bootstrap branch with an appended second tmux command", async () => {
    await withTemporaryRunRoot("compound-bootstrap-grammar", async (runRoot) => {
      const server = await TestServer.create({ runRoot });
      const original = await readFile(server.recordPath, "utf8");
      try {
        const changed = JSON.parse(original) as { bootstrapArgv: string[] };
        changed.bootstrapArgv[10] = `${changed.bootstrapArgv[10] ?? ""} ; kill-server`;
        await writeFile(server.recordPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
        await expect(readFixtureRecord(server.reservationPath)).rejects.toThrow("bootstrap argv");
      } finally {
        await writeFile(server.recordPath, original, { mode: 0o600 });
        await server.dispose();
      }
    });
  });
});
