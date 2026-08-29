/**
 * Compare the ways this library can talk to tmux, on one workload.
 *
 * Three choices are independent: which transport carries a command, whether
 * independent commands overlap, and whether several commands travel in one
 * invocation. They compose, so the interesting number is not any one of them
 * but the grid — and the query output beside it, which is the same in every
 * cell. What differs is the cost.
 *
 * Run with `bun scripts/bench-modes.ts`. Numbers belong to the machine and the
 * tmux that produced them, both of which are reported.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";

import { TmuxConnection } from "../src/_internal/runtime/connection.js";
import { createRuntimeContext, createServerWithRuntime } from "../src/_internal/runtime/context.js";
import type { ConnectionAlias, DaemonEpoch } from "../src/common.js";
import { NodeSpawnTransport } from "../src/_internal/transport/node_spawn_transport.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../src/_internal/transport/types.js";
import type { Server } from "../src/server.js";

import { makeTestDirectory } from "../src/_internal/test/temp_root.js";

/** Counts what crosses the transport, which is what each mode is trying to change. */
class CountingTransport implements CommandTransport {
  calls = 0;
  readonly #inner: CommandTransport;

  constructor(inner: CommandTransport) {
    this.#inner = inner;
  }

  execute(request: CommandRequest): Promise<RawCommandResult> {
    this.calls += 1;
    return this.#inner.execute(request);
  }

  executeGroup(requests: readonly CommandRequest[]): Promise<readonly RawCommandResult[]> {
    this.calls += 1;
    return this.#inner.executeGroup(requests);
  }
}

interface Row {
  readonly batching: string;
  readonly concurrency: string;
  readonly ms: number;
  readonly ordered: boolean;
  /** How many of the repeats came back in the order they were asked for. */
  readonly orderedRuns?: number;
  readonly processes: number;
  readonly result: string;
  readonly transport: string;
}

const WINDOWS = 12;

/** Enough repeats that a single slow or lucky run does not become the number. */
const REPEATS = 3;

function serverOn(
  socketPath: string,
  tmuxBin: string,
): { counter: CountingTransport; server: Server } {
  const counter = new CountingTransport(new NodeSpawnTransport());
  const server = createServerWithRuntime(
    createRuntimeContext({
      connection: new TmuxConnection({ environment: process.env, executable: tmuxBin, socketPath }),
      connectionAlias: randomUUID() as ConnectionAlias,
      daemonEpoch: 0 as DaemonEpoch,
      transport: counter,
    }),
  );
  return { counter, server };
}

/**
 * The same query every cell runs, and whether the result came back in order.
 *
 * Every mode must agree on the set. Whether it agrees on the *sequence* is the
 * thing that actually differs: commands allowed to overlap reach tmux in
 * whatever order they are scheduled, so the windows exist but not necessarily
 * in the order they were asked for.
 */
async function query(server: Server): Promise<{ ordered: boolean; result: string }> {
  const snapshot = await server.snapshot();
  const named = snapshot.windows.where({ name: { startsWith: "w" } });
  const names = named.toArray().map((window) => window.name ?? "");
  const requested = Array.from({ length: WINDOWS }, (_, index) => `w${String(index)}`);
  return {
    ordered: names.join(",") === requested.join(","),
    result: `${String(named.count())} windows`,
  };
}

/** One cell of the grid, measured alone so no other cell is in its numbers. */
async function measureCell(
  transport: "control" | "spawn",
  batching: "one-at-a-time" | "pipeline" | "planned",
  concurrency: "concurrent" | "sequential",
  socketPath: string,
  tmuxBin: string,
): Promise<{ row: Row; tmuxVersion: string }> {
  const { counter, server } = serverOn(socketPath, tmuxBin);
  await server.newSession({ name: "bench" });
  const tmuxVersion = (await server.version()).raw;

  const live = transport === "control" ? await server.connect() : undefined;
  try {
    const target = live ?? server;
    // Derived from the server under test, not the one that made it: a handle
    // carries the runtime it came from, so a session taken from the spawning
    // server would keep spawning however it is used.
    const session = (await target.snapshot()).sessions.one({ name: "bench" });
    const before = counter.calls;
    const started = performance.now();

    if (batching === "planned") {
      // The typed form returns handles after one final snapshot.
      await target.batch(
        Array.from({ length: WINDOWS }, (_, index) =>
          session.plan.newWindow({ name: `w${String(index)}` }),
        ),
      );
    } else if (batching === "pipeline") {
      await target.pipeline(
        Array.from({ length: WINDOWS }, (_, index) => [
          "new-window",
          "-d",
          "-t",
          session.id,
          "-n",
          `w${String(index)}`,
        ]),
      );
    } else if (concurrency === "concurrent") {
      await Promise.all(
        Array.from({ length: WINDOWS }, (_, index) =>
          session.newWindow({ name: `w${String(index)}` }),
        ),
      );
    } else {
      for (let index = 0; index < WINDOWS; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- one at a time is the mode under test.
        await session.newWindow({ name: `w${String(index)}` });
      }
    }

    const ms = performance.now() - started;
    const { ordered, result } = await query(target);
    // Counted on the spawning transport, so a control-mode row reporting
    // processes means its commands did not travel over the connection.
    return {
      row: {
        batching,
        concurrency,
        ms,
        ordered,
        processes: counter.calls - before,
        result,
        transport,
      },
      tmuxVersion,
    };
  } finally {
    await live?.close();
    await server.kill().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const tmuxBin = process.env.LIBTMUX_TMUX_BIN ?? "tmux";
  const root = await makeTestDirectory("ltx-bench-");
  const rows: Row[] = [];
  let tmuxVersion = "unknown";

  const cells = (["spawn", "control"] as const).flatMap((transport) =>
    (["one-at-a-time", "pipeline", "planned"] as const).flatMap((batching) =>
      (["sequential", "concurrent"] as const)
        // Pipeline and planned operations define their own ordering.
        .filter((concurrency) => !(batching !== "one-at-a-time" && concurrency === "concurrent"))
        .map((concurrency) => ({ batching, concurrency, transport })),
    ),
  );

  try {
    for (const [index, cell] of cells.entries()) {
      const samples: Row[] = [];
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        // eslint-disable-next-line no-await-in-loop -- cells run one at a time; overlapping them would put each cell's contention in the others' numbers.
        const measured = await measureCell(
          cell.transport,
          cell.batching,
          cell.concurrency,
          join(root, `s${String(index)}-${String(repeat)}`),
          tmuxBin,
        );
        samples.push(measured.row);
        tmuxVersion = measured.tmuxVersion;
      }
      // A single sample of this is dominated by machine load, so timing is
      // reported as a median and ordering as a rate: one run that came out in
      // order does not make a mode ordered.
      const timings = samples.map((sample) => sample.ms).sort((left, right) => left - right);
      rows.push({
        ...samples[0]!,
        ms: timings[Math.floor(timings.length / 2)] ?? 0,
        orderedRuns: samples.filter((sample) => sample.ordered).length,
      });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }

  const header = [
    "transport",
    "batching",
    "concurrency",
    "wall-clock",
    "processes",
    "query result",
    "order",
  ];
  const body = rows.map((row) => [
    row.transport,
    row.batching,
    row.concurrency,
    `${row.ms.toFixed(0)} ms`,
    String(row.processes),
    row.result,
    (row.orderedRuns ?? 0) === REPEATS
      ? "as requested"
      : `reordered (${String(REPEATS - (row.orderedRuns ?? 0))}/${String(REPEATS)})`,
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index]?.length ?? 0)),
  );
  const render = (cells: readonly string[]): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ")} |`;

  process.stdout.write(`${render(header)}\n`);
  process.stdout.write(`|${widths.map((width) => "-".repeat(width + 2)).join("|")}|\n`);
  for (const line of body) process.stdout.write(`${render(line)}\n`);
  process.stdout.write(
    `\n${WINDOWS} windows per row, median of ${String(REPEATS)}, ${tmuxVersion}, ${String(cpus().length)} cores, ${process.platform}\n`,
  );
}

await main();
