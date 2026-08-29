import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { readProcessIdentity, type ProcessIdentity } from "../../src/_internal/test/run_root.js";
import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import { TmuxTransportError } from "../../src/_internal/transport/types.js";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

const ignoreSigtermFixture = fileURLToPath(
  new URL("../fixtures/ignore_sigterm.mjs", import.meta.url),
);
const echoFixture = fileURLToPath(new URL("../fixtures/echo_argv.mjs", import.meta.url));

const holderPid = /^[1-9]\d*$/u;
// These cases deliberately need a pipe-holding child to survive its parent.
// Bun 1.4's `--no-orphans` mode otherwise propagates to the fixture and kills it.
const detachedHolderEnvironment = Object.freeze({
  ...process.env,
  BUN_FEATURE_FLAG_NO_ORPHANS: "0",
});

/**
 * Wait for a marker to carry usable content, not merely to exist.
 *
 * Both fixtures write their markers with `writeFileSync`, which creates the
 * file before the bytes land. Waiting only for existence therefore reads zero
 * bytes often enough to matter on a loaded runner, and a PID that was about to
 * be valid gets rejected as "holder PID is invalid" — which is how this file
 * failed in CI rather than through any of the timing bounds it asserts.
 */
async function waitForMarker(
  path: string,
  isComplete: (content: string) => boolean = (content) => content.length > 0,
  // A marker that is coming arrives in a few polls; the cap is here to fail one
  // that is never coming, so it has to outlast a loaded machine's node startup.
  attempts = 400,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- one poll at a time, by design.
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (content !== undefined && isComplete(content)) return content;
    // eslint-disable-next-line no-await-in-loop -- the interval between polls is the point.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`marker at ${path} never carried usable content`);
}

async function readHolderIdentity(path: string): Promise<ProcessIdentity> {
  const rawPid = (await waitForMarker(path, (content) => holderPid.test(content.trim()))).trim();
  const identity = await readProcessIdentity(Number(rawPid));
  if (identity === undefined) throw new Error("holder exited before identity capture");
  return identity;
}

function sameIdentity(left: ProcessIdentity | undefined, right: ProcessIdentity): boolean {
  return left?.pid === right.pid && left.startIdentity === right.startIdentity;
}

async function waitForHolderExit(identity: ProcessIdentity): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Holder cleanup is identity-checked and bounded independently of transport settlement.
    // eslint-disable-next-line no-await-in-loop -- each read must follow the preceding signal.
    const current = await readProcessIdentity(identity.pid);
    if (current === undefined || !sameIdentity(current, identity)) return true;
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function stopHolder(identity: ProcessIdentity): Promise<void> {
  if (!sameIdentity(await readProcessIdentity(identity.pid), identity)) return;
  try {
    process.kill(identity.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  if (await waitForHolderExit(identity)) return;
  if (!sameIdentity(await readProcessIdentity(identity.pid), identity)) return;
  process.kill(identity.pid, "SIGKILL");
  if (!(await waitForHolderExit(identity))) throw new Error("holder survived bounded cleanup");
}

describe("transport cancellation", () => {
  test("does not spawn for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });

    try {
      await transport.execute({
        args: [],
        executable: "/definitely/not/an/executable",
        signal: controller.signal,
      });
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(TmuxTransportError);
      expect(error).toMatchObject({ delivery: "not_started", kind: "cancelled" });
    }
  });

  test("closes blocked stdin and escalates an ignored SIGTERM to SIGKILL", async () => {
    const temporaryRoot = await makeTestDirectory("ltx-sigterm-");
    const markerPath = join(temporaryRoot, "ready");
    const controller = new AbortController();
    const transport = new NodeSpawnTransport({ terminationGraceMs: 30 });
    const execution = transport.execute({
      args: [ignoreSigtermFixture, markerPath],
      executable: process.execPath,
      signal: controller.signal,
      stdin: new Uint8Array(16 * 1024 * 1024),
    });

    try {
      await waitForMarker(markerPath);
      controller.abort();
      try {
        await execution;
        throw new Error("expected cancellation");
      } catch (error) {
        expect(error).toBeInstanceOf(TmuxTransportError);
        expect(error).toMatchObject({
          delivery: "indeterminate",
          kind: "cancelled",
          signal: "SIGKILL",
        });
      }
    } finally {
      await execution.catch(() => undefined);
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("bounds execution time and reports an indeterminate timeout", async () => {
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });

    // SIGKILL is the assertion, and it only happens if the fixture got as far
    // as installing its SIGTERM handler. A deadline shorter than a loaded node
    // startup preempts that, SIGTERM alone ends it, and the test reports the
    // wrong signal for the right behaviour. The deadline sits well above
    // startup and well below the fixture's own exit.
    await expect(
      transport.execute({
        args: [ignoreSigtermFixture, "--exit-after=10000"],
        executable: process.execPath,
        timeoutMs: 1_500,
      }),
    ).rejects.toMatchObject({
      delivery: "indeterminate",
      kind: "timeout",
      signal: "SIGKILL",
    });
  });

  test("retains immutable synchronized partial output after cancellation", async () => {
    const temporaryRoot = await makeTestDirectory("ltx-partial-output-");
    const markerPath = join(temporaryRoot, "holder.pid");
    const controller = new AbortController();
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });
    const execution = transport.execute({
      args: [ignoreSigtermFixture, `--inherit-pipes=${markerPath}`],
      environment: detachedHolderEnvironment,
      executable: process.execPath,
      signal: controller.signal,
    });
    let failure: unknown;
    let holder: ProcessIdentity | undefined;
    try {
      holder = await readHolderIdentity(markerPath);
      const interruptedAt = performance.now();
      controller.abort();
      const outcome = await Promise.race([
        execution.then(
          (value) => ({ kind: "value" as const, value }),
          (error: unknown) => ({ error, kind: "error" as const }),
        ),
        new Promise<{ readonly kind: "deadline" }>((resolve) =>
          setTimeout(() => resolve({ kind: "deadline" }), 3_000),
        ),
      ]);
      expect(outcome.kind).not.toBe("deadline");
      // A bound, not a benchmark: it catches a cancellation that never
      // returns, and a tight one only reports how busy the machine is.
      expect(performance.now() - interruptedAt).toBeLessThan(3_000);
      if (outcome.kind === "error") failure = outcome.error;

      expect(failure).toBeInstanceOf(TmuxTransportError);
      expect(failure).toMatchObject({ delivery: "indeterminate", kind: "cancelled" });
      const diagnostic = failure as TmuxTransportError;
      expect(new TextDecoder().decode(diagnostic.stdout)).toBe("launch-frame\n");
      expect(new TextDecoder().decode(diagnostic.stderr)).toBe("launch-diagnostic\n");
      diagnostic.stdout[0] = 0;
      diagnostic.stderr[0] = 0;
      expect(new TextDecoder().decode(diagnostic.stdout)).toBe("launch-frame\n");
      expect(new TextDecoder().decode(diagnostic.stderr)).toBe("launch-diagnostic\n");
      expect(sameIdentity(await readProcessIdentity(holder.pid), holder)).toBe(true);
    } finally {
      if (holder !== undefined) await stopHolder(holder);
      await execution.catch(() => undefined);
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("bounds timeout cleanup when a killed parent has a descendant holding both pipes", async () => {
    const temporaryRoot = await makeTestDirectory("ltx-held-pipes-");
    const markerPath = join(temporaryRoot, "holder.pid");
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });
    const startedAt = performance.now();
    // Long enough that the fixture reaches the point of publishing its holder
    // PID before the transport gives up on it. A deadline shorter than a node
    // startup kills the fixture first, and then the marker this test waits for
    // is never written at all.
    const execution = transport.execute({
      args: [ignoreSigtermFixture, `--inherit-pipes=${markerPath}`],
      environment: detachedHolderEnvironment,
      executable: process.execPath,
      timeoutMs: 2_000,
    });
    let holder: ProcessIdentity | undefined;
    try {
      holder = await readHolderIdentity(markerPath);
      const outcome = await Promise.race([
        execution.then(
          (value) => ({ kind: "value" as const, value }),
          (error: unknown) => ({ error, kind: "error" as const }),
        ),
        new Promise<{ readonly kind: "deadline" }>((resolve) =>
          setTimeout(() => resolve({ kind: "deadline" }), 6_000),
        ),
      ]);
      expect(outcome.kind).not.toBe("deadline");
      expect(performance.now() - startedAt).toBeLessThan(10_000);
      if (outcome.kind !== "error") throw new Error("expected transport timeout");
      expect(outcome.error).toBeInstanceOf(TmuxTransportError);
      expect(outcome.error).toMatchObject({ delivery: "indeterminate", kind: "timeout" });
      const diagnostic = outcome.error as TmuxTransportError;
      expect(new TextDecoder().decode(diagnostic.stdout)).toBe("launch-frame\n");
      expect(new TextDecoder().decode(diagnostic.stderr)).toBe("launch-diagnostic\n");
      expect(sameIdentity(await readProcessIdentity(holder.pid), holder)).toBe(true);
    } finally {
      if (holder !== undefined) await stopHolder(holder);
      await execution.catch(() => undefined);
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("settles each abort and exit race exactly once", async () => {
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });

    const exerciseRace = async (): Promise<void> => {
      const controller = new AbortController();
      let settlements = 0;
      const execution = transport.execute({
        args: ["--input-type=module", "--eval", "setTimeout(() => {}, 15)"],
        executable: process.execPath,
        signal: controller.signal,
      });
      void execution.then(
        () => {
          settlements += 1;
        },
        () => {
          settlements += 1;
        },
      );
      setTimeout(() => controller.abort(), 15);
      await execution.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(settlements).toBe(1);
    };

    for (let index = 0; index < 20; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- races repeat sequentially to avoid hiding orphaned children.
      await exerciseRace();
    }
  }, 10_000);

  test("keeps a terminal exit authoritative while inherited pipes finish closing", async () => {
    const temporaryRoot = await makeTestDirectory("ltx-exit-race-");
    const markerPath = join(temporaryRoot, "exited");
    const controller = new AbortController();
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });
    const execution = transport.execute({
      args: [echoFixture, "--exit-with-inherited-pipe", markerPath, "6000"],
      environment: detachedHolderEnvironment,
      executable: process.execPath,
      signal: controller.signal,
    });
    let holder: ProcessIdentity | undefined;
    try {
      holder = await readHolderIdentity(markerPath);
      // The marker is written from an `exit` handler, so seeing it means the
      // child is exiting, not that the transport has observed it yet. The abort
      // has to land after that observation to be testing precedence rather than
      // racing it, and well inside the window the descendant holds the pipes.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const interruptedAt = performance.now();
      controller.abort();

      const result = await execution;

      expect(result.returncode).toBe(0);
      expect(result.signal).toBeNull();
      expect(performance.now() - interruptedAt).toBeLessThan(3_000);
      expect(sameIdentity(await readProcessIdentity(holder.pid), holder)).toBe(true);
    } finally {
      await execution.catch(() => undefined);
      if (holder !== undefined) await stopHolder(holder);
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 20_000);

  test("bounds post-exit drainage at the timeout while retaining the exit result", async () => {
    const temporaryRoot = await makeTestDirectory("ltx-exit-timeout-");
    const markerPath = join(temporaryRoot, "exited");
    const transport = new NodeSpawnTransport({ terminationGraceMs: 20 });
    const startedAt = performance.now();
    // The deadline has to sit between the fixture exiting, which costs a node
    // startup under four-way parallelism, and the descendant releasing the
    // pipes. Crowding the first turns an honest timeout into what reads as a
    // broken exit result: bounded drainage is what is measured, not fork speed.
    const execution = transport.execute({
      args: [echoFixture, "--exit-with-inherited-pipe", markerPath, "6000"],
      environment: detachedHolderEnvironment,
      executable: process.execPath,
      timeoutMs: 1_500,
    });
    let holder: ProcessIdentity | undefined;
    try {
      holder = await readHolderIdentity(markerPath);
      const result = await execution;

      expect(result.returncode).toBe(0);
      expect(result.signal).toBeNull();
      // Well under the descendant's hold: the point is that it did not wait.
      expect(performance.now() - startedAt).toBeLessThan(4_000);
      expect(sameIdentity(await readProcessIdentity(holder.pid), holder)).toBe(true);
    } finally {
      await execution.catch(() => undefined);
      if (holder !== undefined) await stopHolder(holder);
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 20_000);
});
