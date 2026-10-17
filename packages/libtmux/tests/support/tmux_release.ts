import { spawnSync } from "node:child_process";

import { describe, test } from "bun:test";

/** The release of the `tmux` on PATH, as `tmux -V` writes it (`tmux 3.3a`, or `tmux-3.3a 3.3a`). */
function detect(): string | undefined {
  const done = spawnSync(process.env.LIBTMUX_TMUX_BIN ?? "tmux", ["-V"]);
  if (done.status !== 0) return undefined;
  return new TextDecoder().decode(done.stdout).trim().split(" ").at(-1);
}

export const tmuxRelease = detect();

/** Whether the tmux on PATH is at least `release`, by numbers and patch letter. */
export function tmuxAtLeast(release: string): boolean {
  const key = (raw: string): [number, number, string] | undefined => {
    const match = /^(?:next-)?(\d+)\.(\d+)([a-z]?)/u.exec(raw);
    return match === null ? undefined : [Number(match[1]), Number(match[2]), match[3]!];
  };
  const have = tmuxRelease === undefined ? undefined : key(tmuxRelease);
  const want = key(release);
  if (have === undefined || want === undefined) return false;
  if (have[0] !== want[0]) return have[0] > want[0];
  if (have[1] !== want[1]) return have[1] > want[1];
  return have[2] >= want[2];
}

/** Library-managed control mode needs tmux 3.7; the refusal below it is tested in `optional_features.test.ts`. */
export const controlSupported = tmuxAtLeast("3.7");
export const describeControl = controlSupported ? describe : describe.skip;
export const testControl = controlSupported ? test : test.skip;
