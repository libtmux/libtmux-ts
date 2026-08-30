import { getEventListeners } from "node:events";

import { describe, expect, test } from "bun:test";

import { PaneTail } from "../src/pane_tail.js";
import { TextFilter } from "../src/text.js";

const readableText = (raw: string): string => new TextFilter().push(raw);

describe("text filter", () => {
  test("removes the escapes a shell puts between characters", () => {
    // zsh syntax highlighting colours each character, which is what makes a
    // pattern match against the raw stream fail on a coloured prompt.
    const coloured = "[32mh[32me[32ml[32ml[32mo[39m";
    expect(readableText(coloured)).toBe("hello");
  });

  test("drops an escape sequence that carries an intermediate byte", () => {
    // `ESC ( B` is where xterm's `sgr0` starts, so every `tput sgr0` reaches
    // here. Ending the sequence at the intermediate left the final byte as text.
    expect(readableText("(B[mdone")).toBe("done");
    expect(readableText(")0#8%Gdone")).toBe("done");
  });

  test("keeps a sequence split across two chunks from leaking", () => {
    const filter = new TextFilter();
    // tmux splits notifications wherever it likes, so a stateless filter would
    // emit the tail of a sequence as text.
    expect(filter.push("a[3")).toBe("a");
    expect(filter.push("2mb")).toBe("b");
  });

  test("reads a line rewritten in place as a later line", () => {
    expect(readableText("50%\r100%\r\ndone\n")).toBe("50%\n100%\ndone\n");
  });

  test("applies backspace so a re-edited line is not reported twice", () => {
    expect(readableText("cat\b\bar")).toBe("car");
  });

  test("removes a whole Unicode code point on backspace", () => {
    expect(readableText("🙂\b")).toBe("");
  });

  test("renders a correction that crosses notification chunks", () => {
    const filter = new TextFilter();
    expect(filter.push("cat")).toBe("cat");
    expect(filter.push("\b\bar")).toBe("\ncar");
  });

  test("bounds correction state for a newline-free stream", () => {
    const filter = new TextFilter(16);
    filter.push("x".repeat(2 * 1024 * 1024));

    expect(filter.push("\b")).toBe(`\n${"x".repeat(15)}`);
  });

  test("drops OSC title sequences whichever terminator they use", () => {
    expect(readableText("]0;titletext")).toBe("text");
    expect(readableText("]0;title\\text")).toBe("text");
  });

  test("leaves ordinary text alone", () => {
    expect(readableText("plain output\nsecond line\n")).toBe("plain output\nsecond line\n");
  });
});

describe("pane tail", () => {
  test("returns only what arrived after the cursor", () => {
    const tail = new PaneTail("%1");
    tail.append("first\n");
    const mark = tail.cursor;
    tail.append("second\n");
    expect(tail.read(mark).text).toBe("second\n");
  });

  test("reports what fell out of the buffer rather than losing it silently", () => {
    const tail = new PaneTail("%1", 8);
    const start = tail.cursor;
    tail.append("0123456789abcdef");
    const seen = tail.read(start);
    expect(seen.missedBytes).toBe(8);
    expect(seen.text).toBe("89abcdef");
  });

  test("keeps correction state inside its retained byte limit", () => {
    const tail = new PaneTail("%1", 4);
    tail.append("abcdef");
    tail.append("\b");

    expect(tail.read(undefined).text).toBe("\ncde");
  });

  test("counts cursors and retention in UTF-8 bytes", () => {
    const tail = new PaneTail("%1", 7);
    const start = tail.cursor;
    tail.append("你🙂ab");

    expect(tail.cursor).toEndWith(".9");
    expect(tail.read(start)).toEqual({ cursor: tail.cursor, missedBytes: 3, text: "🙂ab" });
  });

  test("round-trips a byte cursor across multibyte output", () => {
    const tail = new PaneTail("%1");
    tail.append("你");
    const mark = tail.cursor;
    tail.append("🙂");

    expect(mark).toEndWith(".3");
    expect(tail.read(mark).text).toBe("🙂");
  });

  test("does not decode from the middle of a multibyte character", () => {
    const tail = new PaneTail("%1");
    const start = tail.cursor;
    tail.append("🙂x");
    const middle = start.replace(/\.0$/u, ".1");

    expect(tail.read(middle)).toEqual({ cursor: tail.cursor, missedBytes: 3, text: "x" });
  });

  test("refuses a cursor from another tail even when its offset fits", () => {
    const first = new PaneTail("%1");
    first.append("old");
    const second = new PaneTail("%1");
    second.append("new-data");

    expect(() => second.read(first.cursor)).toThrow("different pane tail");
  });

  test("wakes a waiter when output arrives", async () => {
    const tail = new PaneTail("%1");
    const waiting = tail.changed(5_000);
    tail.append("something\n");
    await waiting;
    expect(tail.read(undefined).text).toBe("something\n");
  });

  test("gives up on a waiter as soon as its caller is cancelled", async () => {
    // Without this a cancelled wait keeps its loop and its connection for the
    // rest of a deadline nobody is waiting on.
    const tail = new PaneTail("%1");
    const controller = new AbortController();
    const started = Date.now();
    const waiting = tail.changed(30_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("gives up on a waiter at its deadline", async () => {
    const tail = new PaneTail("%1");
    const started = Date.now();
    await tail.changed(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  test("removes an abort listener when a wait times out", async () => {
    const tail = new PaneTail("%1");
    const controller = new AbortController();

    expect(await tail.changed(5, controller.signal)).toBe("timed_out");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("settles immediately when its caller is already cancelled", async () => {
    const tail = new PaneTail("%1");
    const controller = new AbortController();
    controller.abort();

    expect(await tail.changed(30, controller.signal)).toBe("cancelled");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("closes and wakes every in-flight waiter", async () => {
    const tail = new PaneTail("%1");
    const waiting = tail.changed(30_000);

    tail.close("connection_lost");

    expect(await waiting).toBe("closed");
    expect(tail.endReason).toBe("connection_lost");
  });
});

describe("tail lifetime", () => {
  test("a tail reports going unread, and reading resets it", async () => {
    // Reading is what keeps a tail alive. A pane writing into one nobody is
    // watching is not a reason to hold its connection open — which is what
    // used to happen, because nothing ever removed a tail and so the close
    // path's own guard made it unreachable for any observed session.
    const tail = new PaneTail("%1");
    expect(tail.idleMs(Date.now())).toBeLessThan(50);
    expect(tail.idleMs(Date.now() + 60_000)).toBeGreaterThanOrEqual(60_000);

    tail.append("output nobody asked for");
    // Still idle: the pane wrote, nothing read.
    expect(tail.idleMs(Date.now() + 60_000)).toBeGreaterThanOrEqual(60_000);

    tail.read(undefined);
    expect(tail.idleMs(Date.now())).toBeLessThan(50);
  });
});
