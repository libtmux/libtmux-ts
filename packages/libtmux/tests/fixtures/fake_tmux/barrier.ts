import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { execProgram } from "../../support/bun_program.js";

export interface BarrierConfig {
  readonly tmux: string;
  /** Receives `entered` once the launch has reached this program. */
  readonly entered: string;
  /** Receives the arguments, each followed by a NUL. */
  readonly argumentLog: string;
  /** Receives the launch generation variables, one `NAME=value` per line. */
  readonly environmentLog: string;
  /** The launch waits here until a line is written to this FIFO. */
  readonly releasePipe: string;
  /** Also records `LIBTMUX_ENTRY_SNAPSHOT` first, as `BASE=value` or `BASE=unset`. */
  readonly recordSnapshot?: boolean;
}

/** Waits for a line on a FIFO, so a test can observe a launch that has not started tmux yet. */
function waitForLine(pipe: string): void {
  const descriptor = openSync(pipe, "r");
  try {
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1, null) === 1 && byte[0] !== 10) continue;
  } finally {
    closeSync(descriptor);
  }
}

/** The real tmux behind a barrier: it records its inputs, announces itself and waits to be released. */
export default function barrier(config: BarrierConfig, argv: readonly string[]): never {
  writeFileSync(config.argumentLog, argv.map((argument) => `${argument}\0`).join(""));
  const generation = Object.entries(process.env)
    .filter(([name]) => name.startsWith("LIBTMUX_TEST_GENERATION_"))
    .map(([name, value]) => `${name}=${value ?? ""}\n`);
  const snapshot = config.recordSnapshot
    ? [`BASE=${process.env["LIBTMUX_ENTRY_SNAPSHOT"] ?? "unset"}\n`]
    : [];
  writeFileSync(config.environmentLog, [...snapshot, ...generation].join(""));
  writeFileSync(config.entered, "entered\n");
  waitForLine(config.releasePipe);
  return execProgram(config.tmux, argv);
}
