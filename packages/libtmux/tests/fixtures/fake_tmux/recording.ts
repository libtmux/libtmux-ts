import { appendFileSync } from "node:fs";

export interface RecordingConfig {
  /** Receives one record per call: the arguments, the selector variables that are set, and a divider. */
  readonly trace: string;
}

const SELECTORS = ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "LIBTMUX_SOCKET", "LIBTMUX_SOCKET_PATH"];

/** A tmux that reaches no server. It records which variables choose one, never their values. */
export default function recording(config: RecordingConfig, argv: readonly string[]): number {
  const sandbox = process.env["LIBTMUX_TEST_SANDBOX"];
  const lines = [
    `argv${argv.map((argument) => `\t${argument}`).join("")}`,
    ...SELECTORS.filter((name) => process.env[name] !== undefined).map((name) => `set\t${name}`),
    ...(sandbox !== undefined && sandbox !== "" && process.env["TMUX_TMPDIR"] === sandbox
      ? ["tmpdir-is-sandbox"]
      : []),
    "--",
  ];
  appendFileSync(config.trace, `${lines.join("\n")}\n`);
  return 0;
}
