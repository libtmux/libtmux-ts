import { execProgram } from "../../../libtmux/tests/support/bun_program.js";

export interface ReadmeNpxConfig {
  /** The `tmux-workspace` it hands the rest of the command to. */
  readonly launcher: string;
  /** The package the README's `npx` form names. */
  readonly package: string;
  /** The only version it accepts, which is the manifest's. */
  readonly version: string;
}

/**
 * `npx -y <package>@<version> ...` for exactly the package and version the
 * manifest pins, so a stale pin in a README fails here as it would for a reader.
 */
export default function readmeNpx(config: ReadmeNpxConfig, argv: readonly string[]): number {
  const [flag, specifier, ...rest] = argv;
  if (flag !== "-y" || specifier !== `${config.package}@${config.version}`) {
    process.stderr.write(
      `npx: expected -y ${config.package}@${config.version}, got: ${argv.join(" ")}\n`,
    );
    return 97;
  }
  return execProgram(config.launcher, rest);
}
