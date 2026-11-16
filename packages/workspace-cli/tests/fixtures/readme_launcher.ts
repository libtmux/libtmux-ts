import { execProgram } from "../../../libtmux/tests/support/bun_program.js";

export interface ReadmeLauncherConfig {
  /** The runtime that runs the CLI. */
  readonly runtime: string;
  /** The CLI's entry point in this working tree. */
  readonly entry: string;
}

/** `tmux-workspace` as a reader runs it, resolved to this working tree. */
export default function readmeLauncher(
  config: ReadmeLauncherConfig,
  argv: readonly string[],
): never {
  return execProgram(config.runtime, [config.entry, ...argv]);
}
