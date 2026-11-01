import { describe, expect, test } from "bun:test";

import { createRichProjectedHarness } from "../support/selection_fixtures.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";
import { TmuxTransportError } from "../../src/errors.js";

async function captured(text: string) {
  const { panes: harness } = await createRichProjectedHarness();
  let calls = 0;
  harness.transport.execute = (request) => {
    calls += 1;
    return Promise.resolve({
      cmd: [request.executable, ...flattenInvocation(request)],
      exitCode: 0,
      signal: null,
      stderr: new Uint8Array(),
      stdout: new TextEncoder().encode(text + "\n"),
    });
  };
  return { pane: harness.values[0]!, calls: () => calls, harness };
}

describe("text locations in one capture", () => {
  test("preserves the original capture cancellation cause", async () => {
    const { pane, harness } = await captured("");
    const cause = new TmuxTransportError("capture stopped", {
      kind: "cancelled",
      delivery: "written",
    });
    harness.transport.execute = () => Promise.reject(cause);
    await expect(pane.locateText("ready")).rejects.toBe(cause);
  });
  test("retains wide/combining/astral text with named UTF-16 positions", async () => {
    const { pane } = await captured("界 alpha alpha\né🙂 beta");
    const result = await pane.locateText("beta");
    expect(result.status).toBe("unique");
    if (result.status !== "unique") throw new Error("expected unique result");
    expect(result.match).toEqual({
      startUtf16: 19,
      endUtf16: 23,
      startLineIndex: 1,
      startLineOffsetUtf16: 5,
      endLineIndex: 1,
      endLineOffsetUtf16: 9,
    });
    expect(result.observation.lines).toEqual(["界 alpha alpha", "é🙂 beta"]);
    expect(result.observation.target.id).toBe(pane.id);
    expect(result.observation.completedMonotonicMs).toBeGreaterThanOrEqual(
      result.observation.startedMonotonicMs,
    );
    for (const value of [
      result,
      result.match,
      result.matches,
      result.observation,
      result.observation.lines,
      result.observation.capture,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test("keeps ambiguity when retained matches are capped at one", async () => {
    const { pane } = await captured("界 alpha alpha");
    const result = await pane.locateText("alpha", { maxMatches: 1 });
    expect(result.status).toBe("ambiguous");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.startUtf16).toBe(2);
    expect(result.matchCountAtLeast).toBe(2);
    expect(result.truncated).toBe(true);
    expect("match" in result).toBe(false);
  });

  test("matches overlapping and multiline literals without normalization", async () => {
    const overlaps = await captured("aaa");
    const repeated = await overlaps.pane.locateText("aa");
    expect(repeated.matches.map(({ startUtf16 }) => startUtf16)).toEqual([0, 1]);
    const { pane } = await captured("界 alpha alpha\né🙂 beta");
    const across = await pane.locateText("alpha\né");
    expect(across.status).toBe("unique");
    if (across.status !== "unique") throw new Error("expected unique result");
    expect(across.match).toEqual({
      startUtf16: 8,
      endUtf16: 16,
      startLineIndex: 0,
      startLineOffsetUtf16: 8,
      endLineIndex: 1,
      endLineOffsetUtf16: 2,
    });
    const absent = await pane.locateText("é");
    expect(absent.status).toBe("missing");
    expect(absent.matches).toEqual([]);
    expect(absent.matchCountAtLeast).toBe(0);
  });

  test("retains an earlier capture and its selection after the next capture changes", async () => {
    const { pane, harness } = await captured("earlier");
    const options = { start: -20, joinWrapped: true };
    const earlier = await pane.locateText("earlier", options);
    options.start = -1;
    harness.transport.execute = (request) =>
      Promise.resolve({
        cmd: [request.executable],
        exitCode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode("later\n"),
      });
    const later = await pane.locateText("earlier");
    expect(later.status).toBe("missing");
    expect(earlier.status).toBe("unique");
    expect(earlier.observation.lines).toEqual(["earlier"]);
    expect(earlier.observation.capture).toEqual({
      start: -20,
      alternateScreen: false,
      escapeSequences: false,
      joinWrapped: true,
    });
  });

  test("refuses invalid inputs before capture and oversized captures before matching", async () => {
    const { pane, calls } = await captured("oversized");
    await expect(pane.locateText("")).rejects.toThrow(TypeError);
    await Promise.all(
      [0, -1, 1.5, Infinity, NaN].flatMap((value) => [
        expect(pane.locateText("x", { maxMatches: value })).rejects.toThrow(TypeError),
        expect(pane.locateText("x", { maxTextCodeUnits: value })).rejects.toThrow(TypeError),
      ]),
    );
    await expect(pane.locateText("long", { maxTextCodeUnits: 2 })).rejects.toThrow(RangeError);
    expect(calls()).toBe(0);
    await expect(pane.locateText("x", { maxTextCodeUnits: 2 })).rejects.toThrow(RangeError);
    expect(calls()).toBe(1);
  });
});
