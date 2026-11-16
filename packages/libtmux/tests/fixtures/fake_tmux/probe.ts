import { writeFileSync } from "node:fs";

export interface ProbeConfig {
  readonly exit: number;
  /** A file that receives `text`, or the arguments one per line when `text` is absent. */
  readonly marker?: string;
  readonly text?: string;
}

/** A command that records that it ran, and fails. */
export default function probe(config: ProbeConfig, argv: readonly string[]): number {
  if (config.marker !== undefined) {
    writeFileSync(config.marker, config.text ?? argv.map((argument) => `${argument}\n`).join(""));
  }
  return config.exit;
}
