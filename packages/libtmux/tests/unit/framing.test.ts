import { describe, expect, test } from "bun:test";

import { LineFramer, MAX_CARRY_BYTES } from "../../src/_internal/control/framing.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function feed(framer: LineFramer, text: string): readonly string[] | undefined {
  const lines = framer.push(encoder.encode(text));
  return lines?.map((line) => decoder.decode(line));
}

describe("framing tmux's byte stream into lines", () => {
  test("splits a chunk that holds several complete lines", () => {
    const framer = new LineFramer();
    expect(feed(framer, "%begin 1 2 3\n%end 1 2 3\n")).toEqual(["%begin 1 2 3", "%end 1 2 3"]);
    expect(framer.pending).toBe(0);
  });

  test("holds a partial line back rather than reporting half of one", () => {
    const framer = new LineFramer();
    expect(feed(framer, "%output %1 hel")).toEqual([]);
    expect(framer.pending).toBeGreaterThan(0);
    expect(feed(framer, "lo\n")).toEqual(["%output %1 hello"]);
    expect(framer.pending).toBe(0);
  });

  test("joins a line split across three chunks", () => {
    const framer = new LineFramer();
    expect(feed(framer, "%wind")).toEqual([]);
    expect(feed(framer, "ow-add")).toEqual([]);
    expect(feed(framer, " @1\n")).toEqual(["%window-add @1"]);
  });

  test("finishes one line and holds the start of the next", () => {
    const framer = new LineFramer();
    expect(feed(framer, "first\nsec")).toEqual(["first"]);
    expect(feed(framer, "ond\n")).toEqual(["second"]);
  });

  test("keeps an empty line, which tmux uses for an empty response", () => {
    const framer = new LineFramer();
    expect(feed(framer, "\n\n")).toEqual(["", ""]);
  });

  test("does not split a multi-byte character that spans two chunks", () => {
    const framer = new LineFramer();
    const encoded = encoder.encode("%output %1 ␞\n");
    // The separator is three bytes; cut through the middle.
    expect(framer.push(encoded.subarray(0, encoded.length - 2))).toEqual([]);
    const lines = framer.push(encoded.subarray(encoded.length - 2));
    expect(lines?.map((line) => decoder.decode(line))).toEqual(["%output %1 ␞"]);
  });

  test("gives up on a line past the bound, and drops what it held", () => {
    const framer = new LineFramer();
    expect(framer.push(new Uint8Array(MAX_CARRY_BYTES + 1))).toBeUndefined();
    expect(framer.pending).toBe(0);
  });

  test("honors a validated caller-specific carry bound", () => {
    const framer = new LineFramer(4);
    expect(framer.push(new Uint8Array(4))).toEqual([]);
    expect(framer.push(new Uint8Array(1))).toBeUndefined();
    expect(framer.pending).toBe(0);

    for (const invalid of [0, 1.5, Number.NaN]) {
      expect(() => new LineFramer(invalid)).toThrow("maxCarryBytes must be a positive integer");
    }
  });

  test("holds a fragmented long line without quadratic copying", () => {
    const framer = new LineFramer();
    const chunk = new Uint8Array(4 * 1024);
    const started = performance.now();
    for (let bytes = 0; bytes < 8 * 1024 * 1024; bytes += chunk.length) framer.push(chunk);

    // A broad liveness bound catches repeated whole-carry copies without timing normal work.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(framer.pending).toBe(8 * 1024 * 1024);
  });

  test("forgets a partial line on reset", () => {
    const framer = new LineFramer();
    expect(feed(framer, "half a li")).toEqual([]);
    framer.reset();
    expect(framer.pending).toBe(0);
    expect(feed(framer, "%exit\n")).toEqual(["%exit"]);
  });
});
