import { describe, expect, test } from "bun:test";

import { FORMAT_VALUE_TYPES } from "../../src/_generated/field_types.js";
import { decodeFormatValue, encodeFormatValue } from "../../src/_internal/codec/format_values.js";

describe("decoding what tmux sends", () => {
  test("reads a number field as a number", () => {
    expect(decodeFormatValue("pane_pid", "2334787")).toBe(2334787);
    expect(decodeFormatValue("window_width", "0")).toBe(0);
    expect(decodeFormatValue("scroll_position", "-1")).toBe(-1);
  });

  test("reads a boolean field as a boolean", () => {
    expect(decodeFormatValue("pane_active", "1")).toBe(true);
    expect(decodeFormatValue("pane_active", "0")).toBe(false);
  });

  test("reads a time field as the instant it names", () => {
    expect(decodeFormatValue("session_created", "1786878571")).toEqual(new Date(1786878571000));
  });

  test("leaves a string field exactly as tmux sent it", () => {
    expect(decodeFormatValue("pane_current_command", "zsh")).toBe("zsh");
    // `%0` and `$0` read as integers to anything that only looks at digits, and
    // an identity that decoded to a number would lose its sigil and its meaning.
    expect(decodeFormatValue("pane_id", "%0")).toBe("%0");
    expect(decodeFormatValue("session_id", "$0")).toBe("$0");
  });

  test("keeps an empty string field empty rather than absent", () => {
    // tmux read no configuration files, which is an answer. Only a typed field
    // uses blank to mean the question did not apply.
    expect(decodeFormatValue("config_files", "")).toBe("");
    expect(decodeFormatValue("pane_pid", "")).toBeNull();
    expect(decodeFormatValue("pane_active", "")).toBeNull();
  });

  test("answers null for a value the declared type disowns", () => {
    // A disagreement between this port's table and the tmux in front of it.
    // NaN would travel into arithmetic and surface somewhere else entirely.
    expect(decodeFormatValue("pane_pid", "not a pid")).toBeNull();
    expect(decodeFormatValue("pane_active", "2")).toBeNull();
    expect(decodeFormatValue("session_created", "nonsense")).toBeNull();
  });

  test("answers null for a time that has not happened", () => {
    // tmux writes 0 for a session never attached to. The epoch is not that
    // moment, and a Date of 1970 reads as one.
    expect(decodeFormatValue("session_last_attached", "0")).toBeNull();
  });

  test("refuses a number too large to be exact", () => {
    expect(decodeFormatValue("pane_pid", "9007199254740993")).toBeNull();
  });

  test("passes through a field it has no declaration for", () => {
    expect(decodeFormatValue("not_a_tmux_field", "whatever")).toBe("whatever");
  });
});

describe("encoding what a caller writes", () => {
  test("spells a boolean the way tmux does", () => {
    expect(encodeFormatValue("pane_active", true)).toBe("1");
    expect(encodeFormatValue("pane_active", false)).toBe("0");
  });

  test("spells a number as its digits", () => {
    expect(encodeFormatValue("pane_pid", 2334787)).toBe("2334787");
  });

  test("spells an instant as the epoch seconds tmux reports", () => {
    expect(encodeFormatValue("session_created", new Date(1786878571000))).toBe("1786878571");
  });

  test("leaves a value already in wire form alone", () => {
    // `where({ active: "1" })` keeps working beside `where({ active: true })`.
    expect(encodeFormatValue("pane_active", "1")).toBe("1");
    expect(encodeFormatValue("pane_current_command", "zsh")).toBe("zsh");
    expect(encodeFormatValue("pane_pid", null)).toBeNull();
  });

  test("round-trips every declared field through both directions", () => {
    const samples: Readonly<Record<string, string>> = {
      boolean: "1",
      number: "42",
      time: "1786878571",
    };
    for (const [token, type] of Object.entries(FORMAT_VALUE_TYPES)) {
      const wire = samples[type];
      expect(wire, `${type} has no sample`).toBeDefined();
      expect(encodeFormatValue(token, decodeFormatValue(token, wire!))).toBe(wire!);
    }
  });
});
