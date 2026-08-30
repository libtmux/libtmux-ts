/**
 * What a snapshot costs as the server it reads gets bigger.
 *
 * A snapshot is four list commands whatever the topology, and every row is
 * completed to every field its scope defines. This is the measurement an
 * argument for a reduced model or a field projection has to start from.
 *
 * Run with `bun scripts/bench-snapshot.ts`. Numbers belong to the machine and
 * the tmux that produced them, both of which are reported.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";

import type { ConnectionAlias, DaemonEpoch } from "../src/common.js";
import { TmuxConnection } from "../src/_internal/runtime/connection.js";
import { createRuntimeContext, createServerWithRuntime } from "../src/_internal/runtime/context.js";
import { NodeSpawnTransport } from "../src/_internal/transport/node_spawn_transport.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../src/_internal/transport/types.js";
import type { Server } from "../src/server.js";
import { TEST_HANDLE_PROTOTYPES, makeTestDirectory } from "../src/_internal/test/testkit.js";

/** Counts invocations and the bytes tmux answered with, which is the other cost. */
class MeasuringTransport implements CommandTransport {
  invocations = 0;
  bytes = 0;
  readonly #inner: CommandTransport;

  constructor(inner: CommandTransport) {
    this.#inner = inner;
  }

  async execute(request: CommandRequest): Promise<RawCommandResult> {
    this.invocations += 1;
    const result = await this.#inner.execute(request);
    this.bytes += result.stdout.byteLength;
    return result;
  }
}

interface Shape {
  readonly panesPerWindow: number;
  readonly sessions: number;
  readonly windowsPerSession: number;
}

interface Row {
  readonly bytes: number;
  readonly invocations: number;
  readonly ms: number;
  readonly panes: number;
  readonly shape: string;
}

const SHAPES: readonly Shape[] = [
  { panesPerWindow: 1, sessions: 1, windowsPerSession: 1 },
  { panesPerWindow: 2, sessions: 2, windowsPerSession: 3 },
  { panesPerWindow: 2, sessions: 4, windowsPerSession: 6 },
  { panesPerWindow: 3, sessions: 8, windowsPerSession: 8 },
];

/** Enough repeats that a single slow or lucky run does not become the number. */
const REPEATS = 3;

function serverOn(
  socketPath: string,
  tmuxBin: string,
): { server: Server; transport: MeasuringTransport } {
  const transport = new MeasuringTransport(new NodeSpawnTransport());
  const server = createServerWithRuntime(
    createRuntimeContext({
      connection: new TmuxConnection({ environment: process.env, executable: tmuxBin, socketPath }),
      connectionAlias: randomUUID() as ConnectionAlias,
      daemonEpoch: 0 as DaemonEpoch,
      transport,
    }),
    TEST_HANDLE_PROTOTYPES,
  );
  return { server, transport };
}

async function build(server: Server, shape: Shape): Promise<void> {
  for (let session = 0; session < shape.sessions; session += 1) {
    const name = `s${String(session)}`;
    // eslint-disable-next-line no-await-in-loop -- building the fixture, not the measurement.
    await server.cmd("new-session", ["-d", "-s", name], { target: null });
    for (let window = 1; window < shape.windowsPerSession; window += 1) {
      // eslint-disable-next-line no-await-in-loop -- as above.
      await server.cmd("new-window", ["-d", "-t", name], { target: null });
    }
    // By id: `base-index` is a user option, so counting from zero would
    // measure whichever configuration ran this.
    // eslint-disable-next-line no-await-in-loop -- as above.
    const windows = await server.cmd("list-windows", ["-t", name, "-F", "#{window_id}"], {
      target: null,
    });
    for (const windowId of windows) {
      for (let pane = 1; pane < shape.panesPerWindow; pane += 1) {
        // eslint-disable-next-line no-await-in-loop -- as above.
        await server.cmd("split-window", ["-d", "-t", windowId], { target: null });
      }
    }
  }
}

async function measure(shape: Shape, socketPath: string, tmuxBin: string): Promise<Row> {
  const { server, transport } = serverOn(socketPath, tmuxBin);
  try {
    await build(server, shape);

    // Warm-up: the first snapshot pays for whatever tmux has to page in.
    await server.snapshot();

    const timings: number[] = [];
    let invocations = 0;
    let bytes = 0;
    let panes = 0;
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const invocationsBefore = transport.invocations;
      const bytesBefore = transport.bytes;
      const started = performance.now();
      // eslint-disable-next-line no-await-in-loop -- the measurement is sequential by construction.
      const snapshot = await server.snapshot();
      timings.push(performance.now() - started);
      invocations = transport.invocations - invocationsBefore;
      bytes = transport.bytes - bytesBefore;
      panes = snapshot.panes.count();
    }
    timings.sort((left, right) => left - right);
    return {
      bytes,
      invocations,
      ms: timings[Math.floor(timings.length / 2)] ?? 0,
      panes,
      shape: `${String(shape.sessions)}x${String(shape.windowsPerSession)}x${String(shape.panesPerWindow)}`,
    };
  } finally {
    await server.cmd("kill-server", [], { target: null }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const tmuxBin = process.env.LIBTMUX_TMUX_BIN ?? "tmux";
  const root = await makeTestDirectory("ltx-benchsnap-");
  const rows: Row[] = [];
  let tmuxVersion = "unknown";

  try {
    for (const [index, shape] of SHAPES.entries()) {
      // eslint-disable-next-line no-await-in-loop -- one server at a time; overlapping them would put each shape's contention in the others' numbers.
      rows.push(await measure(shape, join(root, `s${String(index)}`), tmuxBin));
    }
    const { server } = serverOn(join(root, "version"), tmuxBin);
    tmuxVersion = (await server.cmd("-V", [], { target: null }).catch(() => ["unknown"]))[0] ?? "";
    await server.cmd("kill-server", [], { target: null }).catch(() => undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }

  const header = ["sessions x windows x panes", "panes", "wall-clock", "invocations", "bytes read"];
  const body = rows.map((row) => [
    row.shape,
    String(row.panes),
    `${row.ms.toFixed(0)} ms`,
    String(row.invocations),
    `${(row.bytes / 1024).toFixed(0)} KiB`,
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
    `\nmedian of ${String(REPEATS)}, ${tmuxVersion}, ${String(cpus().length)} cores, ${process.platform}\n`,
  );
}

await main();
