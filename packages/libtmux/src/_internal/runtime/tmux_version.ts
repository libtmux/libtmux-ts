import type { TmuxVersion } from "../../types.js";

export type { TmuxVersion };

const taggedVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)([a-z]?)$/u;
const masterSuffix = "-master";
const nextPrefix = "next-";

function invalidVersion(raw: string): TypeError {
  return new TypeError(`invalid tmux version: ${raw}`);
}

function isDevelopmentVersion(raw: string): boolean {
  return raw === "master" || raw.startsWith(nextPrefix) || raw.endsWith(masterSuffix);
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
  const leftDevelopment = isDevelopmentVersion(left.raw);
  const rightDevelopment = isDevelopmentVersion(right.raw);
  if (leftDevelopment !== rightDevelopment) return leftDevelopment ? 1 : -1;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.suffix.localeCompare(right.suffix, "en-US");
}

export function tmuxVersionAtLeast(version: TmuxVersion, minimum: TmuxVersion): boolean {
  return compareTmuxVersions(version, minimum) >= 0;
}

export function tmuxVersionIsExact(version: TmuxVersion, expected: TmuxVersion): boolean {
  return version.raw === expected.raw;
}
