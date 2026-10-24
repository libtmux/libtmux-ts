import { describe, expect, test } from "bun:test";

import { TmuxTransportError, VersionTooLowError } from "../../src/errors.js";
import { parseTmuxVersion } from "../../src/_internal/runtime/tmux_version.js";
import { guardFeatures } from "../../src/_internal/transport/features.js";

type Command = readonly [string, ...string[]];

function guard(version: string, ...commands: Command[]): void {
  guardFeatures(parseTmuxVersion(version), commands);
}

describe("feature guards", () => {
  describe("named buffers", () => {
    test.each(["3.3a"])("refuse deleting and renaming on %s, spelled any way", (version) => {
      for (const command of [
        ["delete-buffer", "-b", "x"],
        ["deleteb", "-b", "x"],
        ["delete-b", "-bx"],
        ["set-buffer", "-b", "x", "-n", "y", "data"],
        ["setb", "-nY", "-b", "x"],
      ] as const) {
        expect(() => guard(version, command)).toThrow(VersionTooLowError);
      }
    });

    test.each(["3.4", "3.5", "3.8", "next-3.9"])("allow them on %s", (version) => {
      guard(version, ["delete-buffer", "-b", "x"], ["set-buffer", "-b", "x", "-n", "y"]);
    });

    test("leave the exact operations of 3.3a alone", () => {
      guard(
        "3.3a",
        ["delete-buffer"],
        ["set-buffer", "-b", "x", "data"],
        ["paste-buffer", "-d", "-b", "x"],
      );
      // A buffer whose name looks like a flag is a value, not a rename.
      guard("3.3a", ["set-buffer", "-b", "-n", "data"]);
    });

    test("refuse inside a list, so one bad item stops the rest", () => {
      expect(() =>
        guard("3.3a", ["set-option", "-g", "@a", "1"], ["delete-buffer", "-b", "x"]),
      ).toThrow(VersionTooLowError);
    });
  });

  describe("layouts below 3.4", () => {
    test.each(["garbage", "not-a-preset", "{ }", "layout"])("refuse %p on 3.3a", (layout) => {
      expect(() => guard("3.3a", ["select-layout", "-t", "@1", layout])).toThrow(
        TmuxTransportError,
      );
    });

    test.each([
      "tiled",
      "tile",
      "even-h",
      "main-vertical",
      "bb62,80x24,0,0,0",
      "bb62,80x24,0,0{40x24,0,0,0,39x24,41,0,1}",
    ])("allow %p on 3.3a", (layout) => {
      guard("3.3a", ["select-layout", "-t", "@1", layout]);
    });

    test("leave flags that read no layout alone", () => {
      guard("3.3a", ["select-layout", "-o"], ["select-layout", "-n"], ["selectl", "-E"]);
    });

    test("do not guard 3.4 and later", () => {
      guard("3.4", ["select-layout", "garbage"]);
    });
  });

  describe("exact 3.7", () => {
    test.each([
      [["new-session", "-d", "-s", "a.b"]],
      [["new-session", "-s", "ok", "-n", "w:1"]],
      [["new-window", "-n", "x.y"]],
      [["neww", "-nx:y"]],
      [["rename-session", "-t", "a", "x.y"]],
      [["renamew", "x:y"]],
      [["break-pane", "-n", "name"]],
      // No name: tmux 3.7 exits on it, with or without a printed id.
      [["break-pane", "-d"]],
      [["break-pane", "-d", "-s", "%1"]],
      [["breakp", "-P", "-F", "#{window_id}"]],
    ] as const)("refuses %j", (command) => {
      expect(() => guard("3.7", command as unknown as Command)).toThrow(TmuxTransportError);
    });

    test("allows the explicit-name repair and plain names", () => {
      guard(
        "3.7",
        ["break-pane", "-d", "-n", "named", "-P", "-F", "#{window_id}"],
        ["new-session", "-d", "-s", "plain", "-n", "window"],
        ["rename-window", "--", "plain"],
      );
    });

    test.each(["3.6b", "3.7a", "3.7d", "3.8"])("leaves %s alone", (version) => {
      guard(version, ["new-session", "-s", "a.b"], ["break-pane", "-n", "x"], ["break-pane", "-d"]);
    });
  });

  test("refresh-client -l is refused below 3.6a, spelled any way", () => {
    for (const command of [
      ["refresh-client", "-l"],
      ["refresh", "-l"],
      ["refresh-c", "-t", "/dev/pts/1", "-l"],
      ["refresh-client", "-Sl"],
      ["refresh-client", "-l%1"],
    ] as const) {
      for (const version of ["3.3a", "3.4", "3.5", "3.5a", "3.6"]) {
        expect(() => guard(version, command)).toThrow(VersionTooLowError);
      }
      for (const version of ["3.6a", "3.6b", "3.7c", "3.8", "next-3.9"]) guard(version, command);
    }
    guard("3.3a", ["refresh-client", "-S"]);
    guard("3.3a", ["refresh-client", "-t", "-l"]);
  });

  test("split-window -p is refused on 3.4 only", () => {
    expect(() => guard("3.4", ["split-window", "-p", "40"])).toThrow(TmuxTransportError);
    expect(() => guard("3.4", ["splitw", "-hp40"])).toThrow(TmuxTransportError);
    guard("3.4", ["split-window", "-l", "40%"]);
    guard("3.3a", ["split-window", "-p", "40"]);
    guard("3.5", ["split-window", "-p", "40"]);
  });

  test("a refused command nested in a string is sent as written", () => {
    // The guard reads each command's own argv, so tmux parses these itself.
    guard("3.7", ["if-shell", "-F", "1", "break-pane -d"]);
    guard("3.5", ["run-shell", "-C", "refresh-client -l"]);
    // Control: the same commands as their own argv are refused.
    expect(() => guard("3.7", ["break-pane", "-d"])).toThrow(TmuxTransportError);
    expect(() => guard("3.5", ["refresh-client", "-l"])).toThrow(VersionTooLowError);
  });

  test("an abbreviation that is ambiguous is not mistaken for a guarded command", () => {
    guard("3.3a", ["d", "-b", "x"], ["set", "-b", "x", "-n", "y"]);
  });
});
