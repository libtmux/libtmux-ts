/**
 * Exercise the bounded and restartable parts of control-mode observation.
 *
 * Wall clock is reported, never gated. The workload does require its terminal
 * state: complete output, a bounded slow-consumer queue, recovered connections,
 * retired daemon-bound handles, and no attached client left behind.
 *
 * Run with `bun scripts/bench-control.ts`. Live-runtime support is Linux-only;
 * the tmux and platform used are reported with the results.
 */
import { rm } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";

import { TmuxServerRestarted } from "../src/exc.js";
import { Server, type DaemonIdentity } from "../src/server.js";
import { createEventStream } from "../src/_internal/control/stream.js";
import { parsePaneId } from "../src/_internal/runtime/ids.js";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
  runWithCleanup,
} from "../src/_internal/test/testkit.js";
import { killExactTmux, launchExactTmux } from "../tests/support/tmux_cleanup.js";

interface Row {
  readonly outcome: string;
  readonly size: string;
  readonly wall: string;
  readonly workload: string;
}

const OUTPUT_BYTES = 1024 * 1024;
const SLOW_BUFFER_SIZE = 64;
const SLOW_EVENTS = 100_000;
const RECONNECT_LOOPS = 5;
const REPLACEMENT_LOOPS = 3;
const LIVE_DEADLINE_MS = 30_000;

interface CleanupState {
  failed: boolean;
}

interface OwnedBenchmarkDaemon {
  pid: number | undefined;
  readonly server: Server;
  readonly socketPath: string;
  readonly tmuxBin: string;
}

function serverOn(socketPath: string, tmuxBin: string): Server {
  assertOwnedSocketPath(socketPath);
  return new Server({ socketPath, tmuxBin });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + LIVE_DEADLINE_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- bounded polling observes another process.
    if (await predicate()) return;
    // eslint-disable-next-line no-await-in-loop -- one pause follows one observation.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failure);
}

async function controlClientNames(server: Server): Promise<string[]> {
  return (
    await server.cmd("list-clients", ["-F", "#{client_control_mode}\t#{client_name}"], {
      target: null,
    })
  )
    .filter((line) => line.startsWith("1\t"))
    .map((line) => line.slice(2));
}

function sameDaemon(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

async function startOwnedDaemon(owned: OwnedBenchmarkDaemon, sessionName: string): Promise<void> {
  if (owned.pid !== undefined) throw new Error("benchmark daemon is already running");
  owned.pid = await launchExactTmux(owned.socketPath, owned.tmuxBin, sessionName);
}

async function stopOwnedDaemon(owned: OwnedBenchmarkDaemon, cleanup: CleanupState): Promise<void> {
  const pid = owned.pid;
  if (pid === undefined) return;
  try {
    await killExactTmux(owned.socketPath, pid);
    owned.pid = undefined;
  } catch (error) {
    cleanup.failed = true;
    throw error;
  }
}

async function withOwnedBenchmarkDaemon<T>(
  socketPath: string,
  tmuxBin: string,
  sessionName: string,
  cleanup: CleanupState,
  body: (owned: OwnedBenchmarkDaemon) => Promise<T>,
): Promise<T> {
  const owned: OwnedBenchmarkDaemon = {
    pid: undefined,
    server: serverOn(socketPath, tmuxBin),
    socketPath,
    tmuxBin,
  };
  return runWithCleanup(
    async () => {
      await startOwnedDaemon(owned, sessionName);
      return body(owned);
    },
    () => stopOwnedDaemon(owned, cleanup),
  );
}

async function measureOutput(
  socketPath: string,
  tmuxBin: string,
  cleanup: CleanupState,
): Promise<Row> {
  return withOwnedBenchmarkDaemon(socketPath, tmuxBin, "output", cleanup, async ({ server }) => {
    const session = (await server.snapshot()).sessions.one({ name: "output" });
    const live = await server.connect({ target: session.id });
    const events = live.subscribe();
    try {
      await events.ready();
      const marker = "LTX-BENCH-OUTPUT-END";
      const markerSplit = marker.length - 3;
      let markerTail = "";
      let receivedBytes = 0;
      const observed = events.find(
        (event) => {
          if (event.kind !== "output") return false;
          receivedBytes += Buffer.byteLength(event.data, "utf8");
          const candidate = markerTail + event.data;
          markerTail = candidate.slice(-(marker.length - 1));
          return candidate.includes(marker);
        },
        { timeoutMs: LIVE_DEADLINE_MS },
      );
      const started = performance.now();
      await session.newWindow({
        name: "stream",
        shellCommand:
          `sh -c 'head -c ${String(OUTPUT_BYTES)} /dev/zero | tr "\\000" x; ` +
          `printf "\\n${marker.slice(0, markerSplit)}"; sleep 0.05; ` +
          `printf "${marker.slice(markerSplit)}\\n"; sleep 30'`,
      });
      const terminal = await observed;
      const elapsed = performance.now() - started;
      if (terminal?.kind !== "output" || receivedBytes < OUTPUT_BYTES) {
        throw new Error(`pane output ended after ${String(receivedBytes)} bytes`);
      }
      if (events.dropped !== 0) {
        throw new Error(`active output subscriber dropped ${String(events.dropped)} events`);
      }
      return {
        outcome: `${String(receivedBytes)} B read, 0 dropped`,
        size: `${String(OUTPUT_BYTES / 1024)} KiB`,
        wall: `${elapsed.toFixed(0)} ms`,
        workload: "sustained pane output",
      };
    } finally {
      await events.close();
      await live.close();
    }
  });
}

async function measureSlowSubscriber(): Promise<Row> {
  const sink = createEventStream(() => Promise.resolve(), SLOW_BUFFER_SIZE);
  const paneId = parsePaneId("%0");
  const started = performance.now();
  for (let index = 0; index < SLOW_EVENTS; index += 1) {
    sink.push({ data: String(index), kind: "output", paneId });
  }
  const elapsed = performance.now() - started;
  sink.finish(undefined);

  const retained: string[] = [];
  for await (const event of sink.stream) {
    if (event.kind === "output") retained.push(event.data);
  }
  const expectedDropped = SLOW_EVENTS - SLOW_BUFFER_SIZE;
  if (
    retained.length !== SLOW_BUFFER_SIZE ||
    retained[0] !== String(expectedDropped) ||
    sink.stream.dropped !== expectedDropped
  ) {
    throw new Error("slow subscriber did not retain exactly its bounded newest suffix");
  }
  return {
    outcome: `${String(retained.length)} retained, ${String(expectedDropped)} dropped`,
    size: `${String(SLOW_EVENTS)} events / ${String(SLOW_BUFFER_SIZE)} slots`,
    wall: `${elapsed.toFixed(0)} ms`,
    workload: "slow subscriber",
  };
}

async function measureReconnects(
  socketPath: string,
  tmuxBin: string,
  cleanup: CleanupState,
): Promise<Row> {
  return withOwnedBenchmarkDaemon(socketPath, tmuxBin, "reconnect", cleanup, async ({ server }) => {
    const baseline = new Set(await controlClientNames(server));
    const live = await server.connect({ reconnect: { attempts: 5, delayMs: 10 } });
    const events = live.subscribe();
    let reconnecting = 0;
    let reconnected = 0;
    let maximumAttempts = 0;
    const drain = (async () => {
      for await (const event of events) {
        if (event.kind === "reconnecting") reconnecting += 1;
        if (event.kind === "reconnected") {
          reconnected += 1;
          maximumAttempts = Math.max(maximumAttempts, event.attempts);
        }
      }
    })();
    try {
      await events.ready();
      const started = performance.now();
      for (let loop = 1; loop <= RECONNECT_LOOPS; loop += 1) {
        // eslint-disable-next-line no-await-in-loop -- each outage must recover before the next.
        const attached = await controlClientNames(server);
        const observer = attached.find((name) => !baseline.has(name));
        if (observer === undefined) throw new Error("reconnect benchmark found no control client");
        // eslint-disable-next-line no-await-in-loop -- the next outage begins only after recovery.
        await server.cmd("detach-client", ["-t", observer], { target: null });
        // eslint-disable-next-line no-await-in-loop -- observes the recovery driven above.
        await waitUntil(
          () => reconnected >= loop,
          `control client did not recover ${String(loop)}`,
        );
      }
      const elapsed = performance.now() - started;
      if (reconnecting !== RECONNECT_LOOPS || reconnected !== RECONNECT_LOOPS) {
        throw new Error(
          `reconnect lifecycle was ${String(reconnecting)} starts and ${String(reconnected)} completions`,
        );
      }
      return {
        outcome: `${String(reconnected)} recovered, max attempt ${String(maximumAttempts)}`,
        size: `${String(RECONNECT_LOOPS)} detachments`,
        wall: `${elapsed.toFixed(0)} ms`,
        workload: "same-daemon reconnect",
      };
    } finally {
      await events.close();
      await live.close();
      await drain;
      await waitUntil(async () => {
        const current = await controlClientNames(server);
        return current.length === baseline.size && current.every((name) => baseline.has(name));
      }, "reconnect benchmark left an attached client");
    }
  });
}

async function measureReplacement(
  socketPath: string,
  tmuxBin: string,
  cleanup: CleanupState,
): Promise<Row> {
  return withOwnedBenchmarkDaemon(socketPath, tmuxBin, "generation-0", cleanup, async (owned) => {
    const { server } = owned;
    const live = await server.connect({ reconnect: { attempts: 100, delayMs: 20 } });
    const events = live.subscribe();
    let reconnected = 0;
    let maximumAttempts = 0;
    const drain = (async () => {
      for await (const event of events) {
        if (event.kind === "reconnected") {
          reconnected += 1;
          maximumAttempts = Math.max(maximumAttempts, event.attempts);
        }
      }
    })();
    const timings: number[] = [];
    let staleRefusals = 0;
    try {
      await events.ready();
      for (let loop = 1; loop <= REPLACEMENT_LOOPS; loop += 1) {
        // eslint-disable-next-line no-await-in-loop -- each successor starts after its predecessor exits.
        const beforeIdentity = await server.daemonIdentity();
        // eslint-disable-next-line no-await-in-loop -- one immutable predecessor handle per generation.
        const stale = (await live.snapshot()).panes.one();
        const started = performance.now();
        // eslint-disable-next-line no-await-in-loop -- the replacement is the measured state transition.
        await stopOwnedDaemon(owned, cleanup);
        // eslint-disable-next-line no-await-in-loop -- starts the measured successor daemon.
        await startOwnedDaemon(owned, `generation-${String(loop)}`);
        // eslint-disable-next-line no-await-in-loop -- waits for this generation's observer attach.
        await waitUntil(
          () => reconnected >= loop,
          `observer did not adopt generation ${String(loop)}`,
        );
        // eslint-disable-next-line no-await-in-loop -- authenticates the recovered command path.
        const successor = await live.snapshot();
        timings.push(performance.now() - started);
        // eslint-disable-next-line no-await-in-loop -- reads identity after the successor capture.
        const afterIdentity = await server.daemonIdentity();
        if (sameDaemon(beforeIdentity, afterIdentity)) {
          throw new Error("daemon replacement preserved the predecessor identity");
        }
        if (successor.sessions.one().name !== `generation-${String(loop)}`) {
          throw new Error("connected snapshot did not reach the successor daemon");
        }
        try {
          // eslint-disable-next-line no-await-in-loop -- checks this predecessor after adoption.
          await stale.refreshed();
        } catch (error) {
          if (error instanceof TmuxServerRestarted) staleRefusals += 1;
          else throw error;
        }
      }
      if (staleRefusals !== REPLACEMENT_LOOPS) {
        throw new Error(`${String(REPLACEMENT_LOOPS - staleRefusals)} stale handles remained live`);
      }
      timings.sort((left, right) => left - right);
      const median = timings[Math.floor(timings.length / 2)] ?? 0;
      const maximum = timings.at(-1) ?? 0;
      return {
        outcome:
          `${String(staleRefusals)} stale handles refused, ` +
          `max attempt ${String(maximumAttempts)}, max ${maximum.toFixed(0)} ms`,
        size: `${String(REPLACEMENT_LOOPS)} daemons`,
        wall: `${median.toFixed(0)} ms median`,
        workload: "daemon replacement",
      };
    } finally {
      await events.close();
      await live.close();
      await drain;
    }
  });
}

function render(rows: readonly Row[]): string {
  const header = ["workload", "size", "wall-clock", "bounded outcome"];
  const body = rows.map((row) => [row.workload, row.size, row.wall, row.outcome]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...body.map(line),
  ].join("\n");
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("the live control benchmark requires Linux");
  const tmuxBin = process.env.LIBTMUX_TMUX_BIN ?? "tmux";
  const root = await makeTestDirectory("ltx-benchcontrol-");
  const cleanup: CleanupState = { failed: false };
  const rows: Row[] = [];
  let tmuxVersion = "unknown";
  try {
    rows.push(await measureOutput(join(root, "output"), tmuxBin, cleanup));
    rows.push(await measureSlowSubscriber());
    rows.push(await measureReconnects(join(root, "reconnect"), tmuxBin, cleanup));
    rows.push(await measureReplacement(join(root, "replacement"), tmuxBin, cleanup));
    const versionServer = serverOn(join(root, "version"), tmuxBin);
    tmuxVersion =
      (await versionServer.cmd("-V", [], { target: null }).catch(() => ["unknown"]))[0] ??
      "unknown";
  } finally {
    if (!cleanup.failed) await rm(root, { force: true, recursive: true });
  }

  process.stdout.write(`${render(rows)}\n`);
  process.stdout.write(
    `\n${tmuxVersion}, ${String(cpus().length)} cores, ${process.platform}; wall clock is reported, not gated\n`,
  );
}

await main();
