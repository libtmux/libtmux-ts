/**
 * Reading back the escaping tmux prints an option or a hook value with.
 *
 * Every pair below was produced by a real tmux: the value was set with
 * `set-option`, and the right-hand side is the line `show-options` printed for
 * it. `args_escape` picks the quoting, and `vis(3)` the escaping inside, so a
 * reader that only strips a surrounding pair of quotes hands back a value with
 * tmux's own escaping still in it.
 */

import { describe, expect, test } from "bun:test";

import { decodeOptionValue, parseNameValueLine } from "../../src/_internal/operations/options.js";

/** value, as tmux printed it. */
const PRINTED: readonly (readonly [string, string])[] = [
  ["plain", "plain"],
  ["", "''"],
  [`he said "hi"`, `"he said \\"hi\\""`],
  ["$HOME/x", `"\\$HOME/x"`],
  ["a; b; c", `"a; b; c"`],
  ["a #{b} c", `"a #{b} c"`],
  ["{ x }", `"{ x }"`],
  ["percent%pct", `"percent%pct"`],
  ["'single'", `"'single'"`],
  ["space in it", `"space in it"`],
  ["trailing ", `"trailing "`],
  ["#hash", `"#hash"`],
  ["back\\slash", "back\\\\slash"],
  ["tab\there", "tab\\there"],
  ["~tilde", "\\~tilde"],
  ["~", "\\~"],
  [`"`, `\\"`],
  ["$", "\\$"],
  ["'", "\\'"],
  [`a"b`, `'a"b'`],
  [`"quoted"`, `'"quoted"'`],
  ['a\tb"c', `'a\\tb"c'`],
  ["multi\nline", `"multi\\nline"`],
  ["carriage\rreturn", "carriage\\rreturn"],
];

describe("option values", () => {
  test("reads back every shape tmux prints", () => {
    for (const [value, printed] of PRINTED) {
      expect(decodeOptionValue(printed)).toBe(value);
    }
  });

  test("reads an empty value as empty rather than as two quotes", () => {
    // `if (value === "")` is the ordinary way to ask, and `''` fails it.
    expect(decodeOptionValue("''")).toBe("");
  });

  test("leaves a value tmux did not need to quote untouched", () => {
    for (const bare of ["on", "off", "2000", "xterm-256color", "main-vertical"]) {
      expect(decodeOptionValue(bare)).toBe(bare);
    }
  });

  test("reads an octal escape back to its byte", () => {
    expect(decodeOptionValue("\\033[1m")).toBe("\u001b[1m");
  });

  test("keeps a trailing backslash rather than reading past the end", () => {
    expect(decodeOptionValue("a\\")).toBe("a\\");
  });

  test("splits the name from the value and decodes only the value", () => {
    expect(parseNameValueLine(`status-left "#S \\$USER"`)).toEqual(["status-left", "#S $USER"]);
    // An array option carries its index in the name, which stays as tmux wrote it.
    expect(parseNameValueLine(`command-alias[0] "split-pane=split-window"`)).toEqual([
      "command-alias[0]",
      "split-pane=split-window",
    ]);
    expect(parseNameValueLine("bell-action")).toEqual(["bell-action", ""]);
    expect(parseNameValueLine("")).toBeUndefined();
  });
});
