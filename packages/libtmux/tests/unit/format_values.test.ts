import { describe, expect, test } from "bun:test";

import { decodeFormatValue, encodeFormatValue } from "../../src/_internal/codec/format_values.js";
import { FORMAT_VALUE_TYPES } from "../../src/_generated/field_types.js";

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

  test("leaves string and identity fields exactly as tmux sent them", () => {
    expect(decodeFormatValue("pane_current_command", "zsh")).toBe("zsh");
    expect(decodeFormatValue("pane_id", "%0")).toBe("%0");
    expect(decodeFormatValue("session_id", "$0")).toBe("$0");
  });

  test("keeps an empty string field empty rather than absent", () => {
    expect(decodeFormatValue("config_files", "")).toBe("");
    expect(decodeFormatValue("pane_pid", "")).toBeNull();
    expect(decodeFormatValue("pane_active", "")).toBeNull();
  });

  test("answers null for a value the declared type disowns", () => {
    expect(decodeFormatValue("pane_pid", "not a pid")).toBeNull();
    expect(decodeFormatValue("pane_active", "2")).toBeNull();
    expect(decodeFormatValue("session_created", "nonsense")).toBeNull();
    expect(decodeFormatValue("pane_id", "@1")).toBeNull();
    expect(decodeFormatValue("session_id", "%1")).toBeNull();
    expect(decodeFormatValue("window_id", "$1")).toBeNull();
  });

  test("answers null for a time that has not happened", () => {
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
    expect(encodeFormatValue("pane_active", "1")).toBe("1");
    expect(encodeFormatValue("pane_current_command", "zsh")).toBe("zsh");
    expect(encodeFormatValue("pane_pid", null)).toBeNull();
  });

  /**
   * The `where` types promise a text domain; this is what makes it a fact.
   *
   * `ScalarCriteria`'s text side is not a taste — it is exactly what this
   * function can emit for that kind of field, which is what lets a serialized
   * query decode back into the same type it was authored in. If the encoder
   * ever emits something outside it, the types start describing documents this
   * library does not produce, and that has to fail here rather than in a
   * consumer's editor.
   */
  test("emits only the text the where types admit, for every declared field", () => {
    const flag = /^[01]$/u;
    // What `${bigint}` accepts: signed integer text, which is what `String` of
    // a safe integer produces.
    const numeric = /^-?\d+$/u;

    const offenders: string[] = [];
    for (const [token, type] of Object.entries(FORMAT_VALUE_TYPES)) {
      const samples =
        type === "boolean"
          ? [true, false]
          : type === "time"
            ? [new Date(0), new Date(1_700_000_000_000), new Date(2_000_000_000_000)]
            : type === "number"
              ? [0, -1, 1, 2_334_787, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]
              : type === "pane-id"
                ? ["%0", "%42"]
                : type === "session-id"
                  ? ["$0", "$42"]
                  : ["@0", "@42"];
      for (const sample of samples) {
        const encoded = encodeFormatValue(token, sample);
        const shape =
          type === "boolean"
            ? flag
            : type === "number" || type === "time"
              ? numeric
              : type === "pane-id"
                ? /^%\d+$/u
                : type === "session-id"
                  ? /^\$\d+$/u
                  : /^@\d+$/u;
        if (typeof encoded !== "string" || !shape.test(encoded)) {
          offenders.push(`${token} (${type}): ${String(sample)} -> ${JSON.stringify(encoded)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("round-trips every declared field through both directions", () => {
    const samples: Readonly<Record<string, string>> = {
      boolean: "1",
      number: "42",
      "pane-id": "%42",
      "session-id": "$42",
      time: "1786878571",
      "window-id": "@42",
    };
    for (const [token, type] of Object.entries(FORMAT_VALUE_TYPES)) {
      const wire = samples[type];
      expect(wire, `${type} has no sample`).toBeDefined();
      expect(encodeFormatValue(token, decodeFormatValue(token, wire!))).toBe(wire!);
    }
  });
});
