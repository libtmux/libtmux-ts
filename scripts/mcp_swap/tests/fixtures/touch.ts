import { writeFileSync } from "node:fs";

export interface TouchConfig {
  /** Files to create empty, as `: > file` does. */
  readonly files: readonly string[];
  /** The exit status; 0 when absent. */
  readonly status?: number;
}

/** A stand-in for a program whose only observable effect is the files it leaves. */
export default function touch(config: TouchConfig): number {
  for (const file of config.files) writeFileSync(file, "");
  return config.status ?? 0;
}
