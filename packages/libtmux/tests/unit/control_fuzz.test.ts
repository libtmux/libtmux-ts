/**
 * Randomized input for the parsers that read bytes this package did not write.
 *
 * tmux's control stream arrives in chunks it chooses, carrying whatever panes
 * printed — invalid UTF-8, embedded newlines, octal escapes, lines longer than
 * any buffer. The hand-written cases beside this file each pin one shape
 * somebody thought of; these pin the properties that have to hold for shapes
 * nobody did.
 *
 * Seeded and bounded, so it runs on the ordinary gate and a failure reproduces
 * from the seed it prints. `LIBTMUX_FUZZ_ITERATIONS` and `LIBTMUX_FUZZ_SEED`
 * turn the same file into a soak without a second toolchain:
 *
 * ```console
 * $ LIBTMUX_FUZZ_ITERATIONS=200000 bun test tests/unit/control_fuzz.test.ts
 * ```
 */

import { describe, expect, test } from "bun:test";

import {
  completeUtf8Length,
  parseControlLine,
  unescapeOutput,
} from "../../src/_internal/control/events.js";
import { LineFramer, MAX_CARRY_BYTES } from "../../src/_internal/control/framing.js";

const NEWLINE = 0x0a;

const ITERATIONS = Number.parseInt(process.env.LIBTMUX_FUZZ_ITERATIONS ?? "2000", 10);
const SEED = Number.parseInt(process.env.LIBTMUX_FUZZ_SEED ?? "0x5eed1e", 16) || 0x5eed1e;

/**
 * A generator with no dependency and no global state.
 *
 * mulberry32: small, well-distributed enough to hit boundaries, and — the part
 * that matters here — reproducible from one 32-bit number, so a failing case
 * comes back from the seed in the message rather than from a saved corpus this
 * repository would then have to carry.
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let drawn = state;
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const encoder = new TextEncoder();

/** Fragments biased towards the protocol, so the search spends its time near it. */
const SHAPES: readonly Uint8Array[] = [
  encoder.encode("%begin 1700000000 1 1"),
  encoder.encode("%end 1700000000 1 1"),
  encoder.encode("%error 1700000000 1 0"),
  encoder.encode("%output %1 hello"),
  encoder.encode("%window-add @1"),
  encoder.encode("%session-changed $0 work"),
  encoder.encode("%exit too far behind"),
  encoder.encode("%unknown-notification-from-a-later-tmux 1 2 3"),
  encoder.encode("\\015\\033[1m"),
  encoder.encode("not a notification at all"),
  encoder.encode(""),
  // Invalid UTF-8: a lone continuation, a truncated three-byte lead, and bytes
  // that begin no character in any encoding tmux might emit.
  Uint8Array.from([0x80]),
  Uint8Array.from([0xe2, 0x90]),
  Uint8Array.from([0xff, 0xfe, 0xc0, 0xc1]),
  Uint8Array.from([0xf0, 0x9f, 0x92, 0xa9]),
  Uint8Array.from([0x00, 0x0d, 0x1b]),
];

/** A stream built from those fragments, with newlines scattered through it. */
function makeStream(next: () => number): Uint8Array {
  const parts: Uint8Array[] = [];
  const fragments = Math.floor(next() * 12);
  for (let index = 0; index < fragments; index += 1) {
    parts.push(SHAPES[Math.floor(next() * SHAPES.length)] ?? new Uint8Array(0));
    if (next() < 0.6) parts.push(Uint8Array.from([NEWLINE]));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const stream = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    stream.set(part, offset);
    offset += part.length;
  }
  return stream;
}

/** Cut a stream at arbitrary offsets, the way a socket read does. */
function chunk(stream: Uint8Array, next: () => number): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < stream.length) {
    const size = 1 + Math.floor(next() * 6);
    chunks.push(stream.subarray(offset, Math.min(offset + size, stream.length)));
    offset += size;
  }
  return chunks;
}

/** The lines a stream holds, ignoring any unterminated tail. */
function completeLines(stream: Uint8Array): readonly string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const newline = stream.indexOf(NEWLINE, start);
    if (newline === -1) break;
    lines.push([...stream.subarray(start, newline)].join(","));
    start = newline + 1;
  }
  return lines;
}

describe("framing under arbitrary chunking", () => {
  test("reports the same lines however the stream is cut up", () => {
    const next = random(SEED);
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const stream = makeStream(next);
      const framer = new LineFramer();
      const seen: string[] = [];
      for (const part of chunk(stream, next)) {
        const lines = framer.push(part);
        // Only a carry past the bound answers undefined, and nothing this
        // generator builds comes close to 16MB.
        expect(lines).toBeDefined();
        for (const line of lines ?? []) seen.push([...line].join(","));
      }

      // The message carries the seed, because that is what reproduces it.
      expect({ iteration, lines: seen, seed: SEED.toString(16) }).toEqual({
        iteration,
        lines: [...completeLines(stream)],
        seed: SEED.toString(16),
      });

      // Whatever followed the last newline is held, not reported and not lost.
      const lastNewline = stream.lastIndexOf(NEWLINE);
      expect(framer.pending).toBe(stream.length - (lastNewline + 1));
    }
  });

  test("never holds more than the bound, whatever arrives", () => {
    const next = random(SEED ^ 0x1111);
    const framer = new LineFramer();
    for (let iteration = 0; iteration < Math.min(ITERATIONS, 500); iteration += 1) {
      framer.push(makeStream(next));
      expect(framer.pending).toBeLessThanOrEqual(MAX_CARRY_BYTES);
    }
  });
});

describe("parsing an arbitrary control line", () => {
  test("answers without throwing, whatever the bytes are", () => {
    const next = random(SEED ^ 0x2222);
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      // One line's worth: the framer has already removed the newlines.
      const line = makeStream(next).filter((byte) => byte !== NEWLINE);
      // A later tmux will publish notifications this release has never seen,
      // and a pane will print bytes that are not text. Neither may end the
      // connection, which is what a throw out of here would do.
      expect(() => parseControlLine(line)).not.toThrow();
      expect(() => unescapeOutput(line)).not.toThrow();
    }
  });

  test("treats a line that is not a notification as one, and no other way", () => {
    const next = random(SEED ^ 0x3333);
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const line = makeStream(next).filter((byte) => byte !== NEWLINE);
      const parsed = parseControlLine(line);
      // `%` is the whole test tmux applies, so this pins the two answers to
      // the one byte that decides between them.
      if (line.length === 0 || line[0] !== 0x25) expect(parsed).toBeUndefined();
      else expect(parsed).toBeDefined();
    }
  });
});

describe("holding back a split character", () => {
  test("never reports more bytes than it was given, and never stalls a pane", () => {
    const next = random(SEED ^ 0x4444);
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const bytes = makeStream(next);
      const complete = completeUtf8Length(bytes);

      expect(complete).toBeLessThanOrEqual(bytes.length);
      expect(complete).toBeGreaterThanOrEqual(0);
      // At most three bytes of a four-byte character can still be waiting, so
      // holding more than that back is a pane that has gone quiet for good.
      expect(bytes.length - complete).toBeLessThanOrEqual(3);
    }
  });

  test("keeps a valid string whole across every possible split", () => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const text = "hello ␞ 💩 ünïcø∂e";
    const encoded = encoder.encode(text);
    for (let cut = 0; cut <= encoded.length; cut += 1) {
      const head = encoded.subarray(0, cut);
      const emitted = decoder.decode(head.subarray(0, completeUtf8Length(head)));
      // Emitting a partial character would put U+FFFD in a pane's output, and
      // the replacement never comes back out once it has been written.
      expect(emitted).not.toContain("�");
      expect(text.startsWith(emitted)).toBe(true);
    }
  });
});
