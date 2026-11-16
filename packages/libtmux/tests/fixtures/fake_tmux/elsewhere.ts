import { execProgram } from "../../support/bun_program.js";

export interface ElsewhereConfig {
  readonly tmux: string;
}

/** A tmux whose shell writes nowhere this process can see, as a remote one would: `: > file` becomes `:`. */
export default function elsewhere(config: ElsewhereConfig, argv: readonly string[]): never {
  return execProgram(
    config.tmux,
    argv.map((argument) => (argument.startsWith(": > ") ? ":" : argument)),
  );
}
