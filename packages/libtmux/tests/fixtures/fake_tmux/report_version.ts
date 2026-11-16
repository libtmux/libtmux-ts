export interface ReportVersionConfig {
  readonly tmux: string;
  /** The version every mention of the real one is rewritten to. */
  readonly reported: string;
}

/** The real tmux, saying it is another version. */
export default function reportVersion(
  config: ReportVersionConfig,
  argv: readonly string[],
): number {
  const real = Bun.spawnSync([config.tmux, "-V"]).stdout.toString().trim().split(" ")[1] ?? "";
  const result = Bun.spawnSync([config.tmux, ...argv], { stderr: "pipe", stdout: "pipe" });
  const rewrite = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString().split(real).join(config.reported);
  process.stdout.write(rewrite(result.stdout));
  process.stderr.write(rewrite(result.stderr));
  return result.exitCode ?? 1;
}
