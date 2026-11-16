import { appendFileSync } from "node:fs";

export interface OldTmuxConfig {
  /** Receives the arguments of every call that is not a version or `run-shell` query. */
  readonly log: string;
}

const NO_SERVER = "no server running on /tmp/none\n";

/** A tmux 3.2a with no server: it reports its version and refuses everything else. */
export default function oldTmux(config: OldTmuxConfig, argv: readonly string[]): number {
  for (const argument of argv) {
    if (argument === "-V") {
      process.stdout.write("tmux 3.2a\n");
      return 0;
    }
    if (argument === "run-shell") {
      process.stderr.write(NO_SERVER);
      return 1;
    }
  }
  appendFileSync(config.log, `${argv.join(" ")}\n`);
  process.stderr.write(NO_SERVER);
  return 1;
}
