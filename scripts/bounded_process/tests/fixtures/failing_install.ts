import { execProgram } from "../../../../packages/libtmux/tests/support/bun_program.js";

export interface FailingInstallConfig {
  /** The npm every other subcommand is handed to. */
  readonly realNpm: string;
}

/** `npm` that fails `install` with status 23 and runs everything else as npm. */
export default function failingInstall(
  config: FailingInstallConfig,
  argv: readonly string[],
): number {
  if (argv[0] === "install") {
    process.stderr.write("forced install failure\n");
    return 23;
  }
  return execProgram(config.realNpm, argv);
}
