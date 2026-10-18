import type { TmuxVersion } from "../../types.js";

export type { TmuxVersion };

/**
 * Where a report sits among the forms tmux has ever printed, or `undefined`.
 *
 * `next-X.Y` precedes `X.Y-rc`, `X.Y-rcN`, `X.Y` and `X.Ya`, minors compare as
 * numbers, and nothing else parses: not bare `master`, `openbsd-*`, a patch
 * letter on a development build, or a `-master` or `-dev` suffix.
 */
function releaseRank(raw: string): readonly number[] | undefined {
  const next = /^next-(\d+)\.(\d+)$/u.exec(raw);
  if (next !== null) return [Number(next[1]), Number(next[2]), 0, 0];
  const release = /^(\d+)\.(\d+)(?:([a-z])|-rc(\d*))?$/u.exec(raw);
  if (release === null) return undefined;
  const [, major, minor, letter, candidate] = release;
  if (letter !== undefined) return [Number(major), Number(minor), 2, letter.charCodeAt(0) - 96];
  if (candidate !== undefined) return [Number(major), Number(minor), 1, Number(candidate || 0)];
  return [Number(major), Number(minor), 2, 0];
}

function order(have: readonly number[], want: readonly number[]): number {
  for (const [index, wanted] of want.entries()) {
    if (have[index]! !== wanted) return have[index]! - wanted;
  }
  return 0;
}

/** Whether a report ranks at or above `minimum`; an unparseable report never does. */
export function releaseAtLeast(raw: string, minimum: string): boolean {
  const have = releaseRank(raw);
  const want = releaseRank(minimum);
  return have !== undefined && want !== undefined && order(have, want) >= 0;
}

/** Read a version in one of the forms tmux prints, or throw. */
export function parseTmuxVersion(raw: string): TmuxVersion {
  const match = /^(?:next-)?(\d+)\.(\d+)([a-z]?)/u.exec(raw);
  if (match === null || releaseRank(raw) === undefined) {
    throw new TypeError(`invalid tmux version: ${raw}`);
  }
  return Object.freeze({
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    raw,
    suffix: match[3]!,
  });
}

/** Negative, zero or positive as `left` ranks below, with or above `right`. */
export function compareTmuxVersions(left: TmuxVersion, right: TmuxVersion): number {
  return order(releaseRank(left.raw)!, releaseRank(right.raw)!);
}

export function tmuxVersionAtLeast(version: TmuxVersion, minimum: TmuxVersion): boolean {
  return compareTmuxVersions(version, minimum) >= 0;
}

export function tmuxVersionIsExact(version: TmuxVersion, expected: TmuxVersion): boolean {
  return version.raw === expected.raw;
}
