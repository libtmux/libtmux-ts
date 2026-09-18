import { describe, expect, test } from "bun:test";

import { layoutChecksum, parseClassicLayout } from "../../src/_internal/operations/layout.js";

const dumped = (body: string): string => `${layoutChecksum(body)},${body}`;

/**
 * Bodies tmux 3.7 through 3.7d exit the server on, measured against each
 * build in the matrix. Every one carries a correct checksum and fails inside
 * a child list, which is the shape a prefix test cannot see.
 */
const CRASHES_TMUX_37 = [
  "80x24,0,0{",
  "80x24,0,0[",
  "80x24,0,0{}",
  "80x24,0,0{,}",
  "80x24,0,0{40x24,0,0,0,}",
  "80x24,0,0{{40x24,0,0,0}}",
  "80x24,0,0[80x12,0,0,1,80x11,0,13{",
];

/** Bodies every supported tmux parses, so the guard may not refuse them. */
const TMUX_APPLIES = [
  "80x24,0,0",
  "80x24,0,0,0",
  "80x24,0,0{40x24,0,0,0}",
  "80x24,0,0{40x24,0,0,0,39x24,41,0,1}",
  "80x24,0,0[80x12,0,0,0,80x11,0,13,1]",
  "80x24,0,0{40x24,0,0,0,39x24,41,0[39x12,41,0,1,39x11,41,13,2]}",
  // A size wider than a u_int: tmux takes it and the pane check refuses it,
  // so parsing must not be where it fails.
  "18446744073709551616x24,0,0,0",
];

/** Bodies every supported tmux refuses, none of which reach a crash. */
const TMUX_REFUSES = [
  "garbage",
  "",
  "80x24,0,0,0}",
  "80x24,0,0,0,",
  "80x24,0,0,0extra",
  // The manual walk tmux advances with takes digits only, so the sign the
  // scan would have accepted is a parse failure.
  "80x24,-1,0,0",
  "80x,0,0,0",
  "x24,0,0,0",
  "80x24,0,0{x}",
  "80x24,0,0{40x24,0,0,0,39x24,41,0,1",
  "80x24,0,0{40x24,0,0,0,39x24,41,0,1}}",
  // tmux 3.7 dumps floating panes with this suffix and its own parser refuses
  // the result, so no release applies it.
  "80x24,0,0{40x24,0,0,0,39x24,41,0,1}<40x10,5,5,2>",
];

describe("layout checksum", () => {
  // tmux answers a mismatch with "invalid layout" before parsing anything, so
  // every oracle run in the differential corpus proves these agree.
  test("matches the values tmux accepted for each corpus body", () => {
    expect(layoutChecksum("80x24,0,0{")).toBe("64aa");
    expect(layoutChecksum("80x24,0,0{}")).toBe("32d2");
    expect(layoutChecksum("garbage")).toBe("c4c8");
    expect(layoutChecksum("")).toBe("0000");
  });

  test("wraps at sixteen bits rather than growing", () => {
    expect(layoutChecksum("x".repeat(4096))).toHaveLength(4);
  });
});

describe("classic layout parsing", () => {
  test("refuses every body that exits tmux 3.7 through 3.7d", () => {
    for (const body of CRASHES_TMUX_37) {
      expect(parseClassicLayout(dumped(body)), body).toEqual({
        kind: "invalid",
        reason: "structure",
      });
    }
  });

  test("accepts every body tmux parses, so a round trip still applies", () => {
    for (const body of TMUX_APPLIES) {
      expect(parseClassicLayout(dumped(body)), body).toEqual({ kind: "valid" });
    }
  });

  test("refuses every body tmux refuses", () => {
    for (const body of TMUX_REFUSES) {
      expect(parseClassicLayout(dumped(body)).kind, body).toBe("invalid");
    }
  });

  test("separates a checksum that does not match from a body that does not parse", () => {
    expect(parseClassicLayout("0000,80x24,0,0,0")).toEqual({
      kind: "invalid",
      reason: "checksum",
    });
    expect(parseClassicLayout(dumped("80x24,0,0,0")).kind).toBe("valid");
  });

  test("reads the checksum case-insensitively, as tmux's own scan does", () => {
    const value = dumped("80x24,0,0,0");
    expect(parseClassicLayout(value.toUpperCase().slice(0, 4) + value.slice(4))).toEqual({
      kind: "valid",
    });
  });

  test("leaves a value carrying no checksum to the preset and version paths", () => {
    for (const value of ["even-horizontal", "tile", "-o", "", '{"V":2,"L":{"t":"p"}}']) {
      expect(parseClassicLayout(value), value).toEqual({ kind: "not-classic" });
    }
  });

  test("refuses nesting deeper than tmux parses without exhausting its own stack", () => {
    const deep = `80x24,0,0${"{80x24,0,0".repeat(1200)}${"}".repeat(1200)}`;
    expect(parseClassicLayout(dumped(deep))).toEqual({ kind: "invalid", reason: "depth" });
  });

  test("accepts nesting up to the depth tmux allows", () => {
    const depth = 400;
    const body = `80x24,0,0${"{80x24,0,0".repeat(depth)}${"}".repeat(depth)}`;
    expect(parseClassicLayout(dumped(body))).toEqual({ kind: "valid" });
  });
});
