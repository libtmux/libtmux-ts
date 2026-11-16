export interface VersionConfig {
  /** What `tmux -V` prints. */
  readonly reported: string;
}

/** A tmux that answers `-V` and nothing else. */
export default function version(config: VersionConfig): number {
  process.stdout.write(`${config.reported}\n`);
  return 0;
}
