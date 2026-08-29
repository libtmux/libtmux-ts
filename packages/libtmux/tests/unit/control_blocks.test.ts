/**
 * What decides a command's response boundary, when its own output can forge one.
 *
 * tmux writes command output to a control client through `server_client_print`
 * with no escaping of a leading `%`, so a pane or a buffer holding `%end 1 2 1`
 * reaches this parser looking exactly like a guard. Only the time and command
 * number tmux stamps on each guard say which lines really are boundaries.
 */

import { describe, expect, test } from "bun:test";

import { BlockTracker } from "../../src/_internal/control/blocks.js";
import { parseControlLine } from "../../src/_internal/control/events.js";
import { parseWindowId } from "../../src/_internal/runtime/ids.js";

const encoder = new TextEncoder();

const place = (tracker: BlockTracker, line: string) =>
  tracker.position(parseControlLine(encoder.encode(line)));

const kinds = (lines: readonly string[]): readonly string[] => {
  const tracker = new BlockTracker();
  return lines.map((line) => place(tracker, line).kind);
};

describe("block pairing", () => {
  test("pairs a response with the guard that opened it", () => {
    expect(kinds(["%begin 100 7 1", "hello", "%end 100 7 1"])).toEqual(["begin", "body", "end"]);
  });

  test("reads ownership and failure from the guards", () => {
    const tracker = new BlockTracker();
    expect(place(tracker, "%begin 100 7 1")).toEqual({ fromClient: true, kind: "begin" });
    expect(place(tracker, "%error 100 7 1")).toEqual({
      failed: true,
      fromClient: true,
      kind: "end",
    });
    expect(place(tracker, "%begin 100 8 0")).toEqual({ fromClient: false, kind: "begin" });
    expect(place(tracker, "%end 100 8 0")).toEqual({
      failed: false,
      fromClient: false,
      kind: "end",
    });
  });

  test("keeps a printed end guard as output, whatever its flags", () => {
    for (const forged of ["%end 1 2 1", "%end 1 2 0", "%error 1 2 1", "%error 1 2 0"]) {
      expect(kinds(["%begin 100 7 1", forged, "%end 100 7 1"])).toEqual(["begin", "body", "end"]);
    }
  });

  test("keeps a printed begin guard as output rather than opening a second block", () => {
    // Opening one would take the next caller's place in the queue, and every
    // command after it would answer with its predecessor's reply.
    expect(kinds(["%begin 100 7 1", "%begin 1 2 1", "%end 100 7 1", "%window-add @1"])).toEqual([
      "begin",
      "body",
      "end",
      "notification",
    ]);
  });

  test("closes on the matching guard even after a forged one names another command", () => {
    const tracker = new BlockTracker();
    place(tracker, "%begin 100 7 1");
    expect(place(tracker, "%end 100 6 1").kind).toBe("body");
    expect(place(tracker, "%end 101 7 1").kind).toBe("body");
    expect(place(tracker, "%end 100 7 1").kind).toBe("end");
    expect(tracker.inBlock).toBe(false);
  });

  test("keeps a line too short to be a guard as output", () => {
    expect(kinds(["%begin 100 7 1", "%end", "%end 100 7", "%end 100 7 1"])).toEqual([
      "begin",
      "body",
      "body",
      "end",
    ]);
  });

  test("ignores trailing fields a later tmux may add", () => {
    expect(kinds(["%begin 100 7 1 extra", "%end 100 7 1 extra"])).toEqual(["begin", "end"]);
  });

  test("ignores a guard closing a block that was never opened", () => {
    // Answering one would resolve an attach nobody asked about.
    expect(kinds(["%end 100 7 0", "%error 100 7 0"])).toEqual(["ignore", "ignore"]);
  });

  test("carries the notification rather than making the caller narrow it again", () => {
    expect(place(new BlockTracker(), "%window-add @3")).toEqual({
      event: { kind: "window-add", windowId: parseWindowId("@3") },
      kind: "notification",
    });
  });

  test("forgets an open block on reset, so a reconnect starts a sentence", () => {
    const tracker = new BlockTracker();
    place(tracker, "%begin 100 7 1");
    expect(tracker.inBlock).toBe(true);
    tracker.reset();
    expect(tracker.inBlock).toBe(false);
    expect(place(tracker, "%window-add @1").kind).toBe("notification");
  });
});

describe("block pairing under arbitrary output", () => {
  /**
   * A block ends where its own guard says and nowhere else.
   *
   * The body is drawn from the shapes that forge a boundary, so the property
   * fails for any pairing weaker than time and command number together.
   */
  test("survives a body of forged guards", () => {
    const forgeries = [
      "%begin 1 2 1",
      "%end 1 2 1",
      "%error 1 2 0",
      "%begin 100 7 0",
      "%end 100 6 1",
      "%output %1 x",
      "%exit",
      "plain",
      "",
    ];
    for (let index = 0; index < forgeries.length; index += 1) {
      const body = [...forgeries.slice(index), ...forgeries.slice(0, index)];
      const tracker = new BlockTracker();
      expect(place(tracker, "%begin 100 7 1").kind).toBe("begin");
      for (const line of body) expect(place(tracker, line).kind).toBe("body");
      expect(place(tracker, "%end 100 7 1").kind).toBe("end");
      expect(tracker.inBlock).toBe(false);
    }
  });
});
