import { dirname, join } from "node:path";
import { writeRecording } from "./fake_tmux.js";

/** A tmux that reaches no server, writing its `trace` beside itself; `parseCalls` reads it. */
export function writeRecordingTmux(destination: string): Promise<string> {
  return writeRecording(destination, { trace: join(dirname(destination), "trace") });
}

export interface Call {
  readonly argv: readonly string[];
  readonly set: readonly string[];
  readonly tmpdirIsSandbox: boolean;
}

export function parseCalls(trace: string): readonly Call[] {
  return trace
    .split("--\n")
    .filter((record) => record !== "")
    .map((record) => {
      const [first = "", ...rest] = record.split("\n").filter((line) => line !== "");
      return {
        argv: first.split("\t").slice(1),
        set: rest.filter((line) => line.startsWith("set\t")).map((line) => line.slice(4)),
        tmpdirIsSandbox: rest.includes("tmpdir-is-sandbox"),
      };
    });
}
