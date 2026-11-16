import { writeFileSync } from "node:fs";

export interface IgnoreTermConfig {
  /** Receives `spawned` once the program is running. */
  readonly spawned: string;
}

/** A program that records its start, ignores SIGTERM and never exits on its own. */
export default function ignoreTerm(config: IgnoreTermConfig): Promise<never> {
  process.on("SIGTERM", () => undefined);
  writeFileSync(config.spawned, "spawned");
  setInterval(() => undefined, 1 << 30);
  return new Promise<never>(() => undefined);
}
