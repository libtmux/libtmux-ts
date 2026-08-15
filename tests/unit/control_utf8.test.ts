import { describe, expect, test } from "bun:test";

import { completeUtf8Length } from "../../src/_internal/control/events.js";

/**
 * Where a run of bytes stops being a whole character.
 *
 * tmux emits `%output` for whatever it read from the pty, so a multi-byte
 * character can straddle two notifications. Decoding each alone replaces the
 * halves with U+FFFD, which is silent corruption of any non-ASCII pane output.
 */

const encoder = new TextEncoder();

describe("UTF-8 boundary", () => {
  test("passes text that ends on a character", () => {
    for (const text of ["", "plain ascii", "héllo", "日本語", "🚀🌍", "mixed 日本 🚀 text"]) {
      const bytes = encoder.encode(text);
      expect(completeUtf8Length(bytes)).toBe(bytes.length);
    }
  });

  test("stops before an incomplete character, at every split point", () => {
    // One of each width, so a two-, three-, and four-byte character is cut at
    // each of its interior positions.
    for (const character of ["é", "日", "🚀"]) {
      const bytes = encoder.encode(`ok${character}`);
      for (let cut = 1; cut < bytes.length - 2; cut += 1) {
        const truncated = bytes.subarray(0, bytes.length - cut);
        // Everything up to the character survives; the fragment does not.
        expect(completeUtf8Length(truncated)).toBe(2);
      }
    }
  });

  test("rejoins a character split across two reads", () => {
    const bytes = encoder.encode("a🚀b");
    for (let split = 1; split < bytes.length; split += 1) {
      const head = bytes.subarray(0, split);
      const complete = completeUtf8Length(head);
      const held = head.subarray(complete);
      const rest = new Uint8Array(held.length + bytes.length - split);
      rest.set(held);
      rest.set(bytes.subarray(split), held.length);

      const decoder = new TextDecoder();
      const text =
        decoder.decode(head.subarray(0, complete)) +
        decoder.decode(rest.subarray(0, completeUtf8Length(rest)));

      expect(text).toBe("a🚀b");
    }
  });

  test("does not stall on a byte that starts nothing", () => {
    // A stray continuation byte is not the start of a character, so holding it
    // back would wait for a continuation that never comes.
    expect(completeUtf8Length(new Uint8Array([0x80]))).toBe(1);
    expect(completeUtf8Length(new Uint8Array([0xff]))).toBe(1);
  });
});
