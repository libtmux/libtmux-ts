import type { TmuxVersion } from "../../types.js";

export type { TmuxVersion };

const taggedVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)([a-z]?)$/u;
const masterSuffix = "-master";
const nextPrefix = "next-";

function invalidVersion(raw: string): TypeError {
  return new TypeError(`invalid tmux version: ${raw}`);
}

/**
 * Every raw version string is one of three kinds:
 *
 * - `tagged` — an ordinary release, such as `3.7a`.
 * - `named-next` (`next-X.Y`) — a development build heading toward release
 *   `X.Y`, which it has not shipped yet.
 * - `untargeted` (bare `master`, or `<tag>-master`) — a development build
 *   that names no release it is heading toward.
 */
type DevelopmentKind = "named-next" | "tagged" | "untargeted";

function developmentKind(raw: string): DevelopmentKind {
  if (raw === "master" || raw.endsWith(masterSuffix)) return "untargeted";
  if (raw.startsWith(nextPrefix)) return "named-next";
  return "tagged";
}

export function parseTmuxVersion(raw: string): TmuxVersion {
  if (raw === "master") {
    return Object.freeze({
      major: 0,
      minor: 0,
      raw,
      suffix: "",
    });
  }

  const tagged = raw.startsWith(nextPrefix)
    ? raw.slice(nextPrefix.length)
    : raw.endsWith(masterSuffix)
      ? raw.slice(0, -masterSuffix.length)
      : raw;
  const match = taggedVersionPattern.exec(tagged);
  if (match === null) throw invalidVersion(raw);
  return Object.freeze({
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    raw,
    suffix: match[3]!,
  });
}

export function compareTmuxVersions(left: TmuxVersion, right: TmuxVersion): number {
  const leftKind = developmentKind(left.raw);
  const rightKind = developmentKind(right.raw);

  // An untargeted build names no release it is heading toward, so nothing
  // bounds it: it outranks every tagged release and every named-next build,
  // which does name one.
  if (leftKind === "untargeted" && rightKind !== "untargeted") return 1;
  if (rightKind === "untargeted" && leftKind !== "untargeted") return -1;

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  const suffixOrder = left.suffix.localeCompare(right.suffix, "en-US");
  if (suffixOrder !== 0) return suffixOrder;

  // Same major, minor, and suffix: a named-next build names exactly this
  // release and has not shipped it yet, so it ranks just below the tagged
  // release it names.
  if (leftKind !== rightKind) return leftKind === "named-next" ? -1 : 1;
  return 0;
}

export function tmuxVersionAtLeast(version: TmuxVersion, minimum: TmuxVersion): boolean {
  return compareTmuxVersions(version, minimum) >= 0;
}

export function tmuxVersionIsExact(version: TmuxVersion, expected: TmuxVersion): boolean {
  return version.raw === expected.raw;
}
