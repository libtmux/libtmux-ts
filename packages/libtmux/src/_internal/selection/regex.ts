import {
  at,
  frozenRecord,
  invalidQuery,
  isObject,
  listed,
  snapshotObject,
  withActive,
  type ParseState,
} from "./validation.js";

const regexFlags = new Set(["", "m", "s", "ms"]);
const escapedRegexLiterals = new Set("^$\\.*+?()[]{}|/-".split(""));
const maximumRegexPatternLength = 512;

/** Reject patterns outside the work budget without echoing caller operands. */
function validateRegexPattern(pattern: string, flags: string, state: ParseState): void {
  const bad = (offset: number, reason: string): never =>
    invalidQuery(state, `invalid regular expression at offset ${String(offset)}: ${reason}`);

  if (pattern.length > maximumRegexPatternLength) {
    return bad(maximumRegexPatternLength, "the pattern exceeds the 512-code-unit limit");
  }
  let alternatives = 0;
  let firstQuantifierOffset: number | undefined;
  let groupDepth = 0;
  let inClass = false;
  let classContent = 0;
  let canQuantify = false;
  let canQuantifyGroup = false;
  let quantifiers = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) return bad(index, "the pattern ended mid-character");

    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return bad(index, "a trailing backslash escapes nothing");
      if (!escapedRegexLiterals.has(escaped)) {
        return bad(index, `only ${listed([...escapedRegexLiterals])} may be escaped`);
      }
      index += 1;
      if (inClass) classContent += 1;
      canQuantify = true;
      canQuantifyGroup = false;
      continue;
    }

    if (inClass) {
      const code = character.codePointAt(0);
      if (code === undefined || code < 0x20 || code > 0x7e) {
        return bad(index, "a character class takes printable ASCII only");
      }
      if (character === "[") return bad(index, "a nested class is not accepted");
      if (classContent === 0 && character === "^") {
        return bad(index, "a negated class is not accepted");
      }
      if (character === "]") {
        if (classContent === 0) return bad(index, "an empty character class matches nothing");
        inClass = false;
        canQuantify = true;
        canQuantifyGroup = false;
        continue;
      }
      if (
        (character === "&" && pattern[index + 1] === "&") ||
        (character === "-" && pattern[index + 1] === "-")
      ) {
        return bad(index, "a class set operator is not accepted");
      }
      classContent += 1;
      continue;
    }

    if (character === "[") {
      inClass = true;
      classContent = 0;
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character === "]") return bad(index, "a class was closed that was never opened");
    if (character === "}") return bad(index, "a quantifier was closed that was never opened");
    if (character === "(") {
      if (pattern[index + 1] === "?") {
        if (pattern[index + 2] !== ":") {
          return bad(index, "only a non-capturing group `(?:` takes a `?` here");
        }
        index += 2;
      }
      groupDepth += 1;
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character === ")") {
      if (groupDepth === 0) return bad(index, "a group was closed that was never opened");
      groupDepth -= 1;
      canQuantify = true;
      canQuantifyGroup = true;
      continue;
    }
    if (character === "{") {
      if (!canQuantify) return bad(index, "a quantifier follows nothing to repeat");
      if (canQuantifyGroup) return bad(index, "a group cannot be repeated");
      const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(index));
      if (match === null) return bad(index, "a counted quantifier reads `{n}`, `{n,}` or `{n,m}`");
      const lower = Number(match[1]);
      const upper = match[2] === undefined || match[2] === "" ? undefined : Number(match[2]);
      if (
        !Number.isSafeInteger(lower) ||
        (upper !== undefined && (!Number.isSafeInteger(upper) || upper < lower))
      ) {
        return bad(index, "counted bounds must be ascending safe integers");
      }
      const next = pattern[index + match[0].length];
      if (next === "?" || next === "+") {
        return bad(index, "a lazy or possessive quantifier is not accepted");
      }
      quantifiers += 1;
      if (quantifiers > 1) return bad(index, "a pattern can contain only one quantifier");
      firstQuantifierOffset = index;
      index += match[0].length - 1;
      canQuantify = false;
      continue;
    }
    if (character === "*" || character === "+" || character === "?") {
      if (!canQuantify) return bad(index, "a quantifier follows nothing to repeat");
      if (canQuantifyGroup) return bad(index, "a group cannot be repeated");
      if (pattern[index + 1] === "?" || pattern[index + 1] === "+") {
        return bad(index, "a lazy or possessive quantifier is not accepted");
      }
      quantifiers += 1;
      if (quantifiers > 1) return bad(index, "a pattern can contain only one quantifier");
      firstQuantifierOffset = index;
      canQuantify = false;
      continue;
    }
    if (character === "|") {
      alternatives += 1;
      if (alternatives > 1) return bad(index, "a pattern can contain only one alternative");
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character === "^" || character === "$") {
      canQuantify = false;
      canQuantifyGroup = false;
      continue;
    }
    if (character.codePointAt(0) !== undefined && character.codePointAt(0)! < 0x20) {
      return bad(index, "a control character is not accepted");
    }
    canQuantify = true;
    canQuantifyGroup = false;
  }

  if (inClass) return bad(pattern.length, "a character class was never closed");
  if (groupDepth !== 0) return bad(pattern.length, "a group was never closed");
  if (firstQuantifierOffset !== undefined) {
    if (pattern[0] !== "^") {
      return bad(firstQuantifierOffset, "a pattern with repetition must start with `^`");
    }
    if (alternatives !== 0) {
      return bad(firstQuantifierOffset, "a repeated pattern cannot contain an alternative");
    }
    if (flags.includes("m")) {
      return bad(firstQuantifierOffset, "a repeated pattern cannot use multiline mode");
    }
  }
}

function compileRegex(
  pattern: string,
  flags: string,
  insensitive: boolean,
  state: ParseState,
): RegExp {
  validateRegexPattern(pattern, flags, state);
  try {
    return new RegExp(pattern, `${flags}${insensitive ? "iu" : "u"}`);
  } catch (error) {
    return invalidQuery(state, "the regular expression did not compile", error);
  }
}

export function parseRegex(
  value: unknown,
  insensitive: boolean,
  state: ParseState,
): { readonly query: Readonly<Record<string, unknown>>; readonly regex: RegExp } {
  if (!isObject(value)) {
    return invalidQuery(state, "expected an object with a pattern and flags, not a bare string");
  }
  return withActive(value, state, () => {
    const record = snapshotObject(value, state);
    if (record.size !== 2 || !record.has("flags") || !record.has("pattern")) {
      return invalidQuery(state, 'expected exactly the keys "pattern" and "flags"');
    }
    const flags = record.get("flags");
    const pattern = record.get("pattern");
    if (typeof pattern !== "string") {
      return at(state, "pattern", () => invalidQuery(state, "expected a string"));
    }
    if (typeof flags !== "string" || !regexFlags.has(flags)) {
      return at(state, "flags", () =>
        invalidQuery(state, `expected one of ${listed([...regexFlags].map((flag) => flag))}`),
      );
    }
    return {
      query: frozenRecord([
        ["flags", flags],
        ["pattern", pattern],
      ]),
      regex: compileRegex(pattern, flags, insensitive, state),
    };
  });
}
