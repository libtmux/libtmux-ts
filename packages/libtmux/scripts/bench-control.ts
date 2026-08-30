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
import { assertOwnedSocketPath, makeTestDirectory } from "../src/_internal/test/testkit.js";

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

async function waitForServerExit(server: Server): Promise<void> {
  await waitUntil(
    () =>
      server.isAlive().then(
        (alive) => !alive,
        () => true,
      ),
    "tmux daemon did not exit",
  );
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

function sameDaemon(left: DaemonIdentity | undefined, right: DaemonIdentity | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.startTime === right.startTime
  );
}

async function measureOutput(socketPath: string, tmuxBin: string): Promise<Row> {
  const server = serverOn(socketPath, tmuxBin);
  try {
    await server.newSession({ name: "output", shellCommand: "exec cat" });
    const session = (await server.snapshot()).sessions.one({ name: "output" });
    const live = await server.connect({ target: session.id });
    const events = live.subscribe();
    try {
      await events.ready();
      const marker = "LTX-BENCH-OUTPUT-END";
      let receivedBytes = 0;
      const observed = events.find(
        (event) => {
          if (event.kind !== "output") return false;
          receivedBytes += Buffer.byteLength(event.data, "utf8");
          return event.data.includes(marker);
        },
        { timeoutMs: LIVE_DEADLINE_MS },
      );
      const started = performance.now();
      await session.newWindow({
        name: "stream",
        shellCommand:
          `sh -c 'head -c ${String(OUTPUT_BYTES)} /dev/zero | tr "\\000" x; ` +
          `printf "\\n${marker}\\n"; sleep 30'`,
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
  } finally {
    await server.cmd("kill-server", [], { target: null }).catch(() => undefined);
  }
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

async function measureReconnects(socketPath: string, tmuxBin: string): Promise<Row> {
  const server = serverOn(socketPath, tmuxBin);
  try {
    await server.newSession({ name: "reconnect", shellCommand: "exec cat" });
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
  } finally {
    await server.cmd("kill-server", [], { target: null }).catch(() => undefined);
  }
}

async function measureReplacement(socketPath: string, tmuxBin: string): Promise<Row> {
  const server = serverOn(socketPath, tmuxBin);
  try {
    await server.newSession({ name: "generation-0", shellCommand: "exec cat" });
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
        await server.cmd("kill-server", [], { target: null }).catch(() => undefined);
        // eslint-disable-next-line no-await-in-loop -- the socket must be quiescent before reuse.
        await waitForServerExit(server);
        // eslint-disable-next-line no-await-in-loop -- starts the measured successor daemon.
        await server.cmd("new-session", ["-d", "-s", `generation-${String(loop)}`, "exec cat"], {
          target: null,
        });
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
  } finally {
    await server.cmd("kill-server", [], { target: null }).catch(() => undefined);
  }
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
  const tmuxBin = process.env.LIBTMUX_TMUX_BIN ?? "tmux";
  const root = await makeTestDirectory("ltx-benchcontrol-");
  const rows: Row[] = [];
  let tmuxVersion = "unknown";
  try {
    rows.push(await measureOutput(join(root, "output"), tmuxBin));
    rows.push(await measureSlowSubscriber());
    rows.push(await measureReconnects(join(root, "reconnect"), tmuxBin));
    rows.push(await measureReplacement(join(root, "replacement"), tmuxBin));
    const versionServer = serverOn(join(root, "version"), tmuxBin);
    tmuxVersion =
      (await versionServer.cmd("-V", [], { target: null }).catch(() => ["unknown"]))[0] ??
      "unknown";
  } finally {
    await rm(root, { force: true, recursive: true });
  }

  process.stdout.write(`${render(rows)}\n`);
  process.stdout.write(
    `\n${tmuxVersion}, ${String(cpus().length)} cores, ${process.platform}; wall clock is reported, not gated\n`,
  );
}

await main();
