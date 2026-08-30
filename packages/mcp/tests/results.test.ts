import { describe, expect, test } from "bun:test";

import { MAX_RESULT_BYTES } from "../src/policy.js";
import { fail, ok, renderOutput, tailLines } from "../src/results.js";
import { paneContentUri } from "../src/uris.js";

describe("results", () => {
  test("keeps the tail, because a verdict is at the end", () => {
    const trimmed = tailLines(["a", "b", "c", "d"], 2);
    expect(trimmed.lines).toEqual(["c", "d"]);
    expect(trimmed.droppedLines).toBe(2);
    expect(renderOutput(trimmed)).toContain("2 earlier lines omitted");
  });

  test("returns no lines when none fit the budget", () => {
    expect(tailLines(["a", "b"], 0)).toEqual({ droppedLines: 2, lines: [] });
  });

  test("carries no structuredContent on failure", () => {
    // A client validates structuredContent against the tool's outputSchema even
    // for an error, so a failure that carried its own shape would be rejected
    // as a protocol violation and the model would never read the reason.
    const failure = fail({ hint: "try %1", reason: "No pane %9" });
    expect(failure.isError).toBe(true);
    expect(failure).not.toHaveProperty("structuredContent");
    expect(failure.content[0]).toMatchObject({ text: expect.stringContaining("try %1") });
  });

  test("carries both shapes on success", () => {
    const result = ok({ value: 1 }, "one");
    expect(result.structuredContent).toEqual({ value: 1 });
    expect(result.content[0]).toMatchObject({ text: "one" });
  });

  test("bounds every success and failure text envelope", () => {
    const oversized = "x".repeat(MAX_RESULT_BYTES + 1_000);
    for (const result of [ok({ value: 1 }, oversized), fail({ reason: oversized })]) {
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("expected text content");
      expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES + 256);
      expect(content.text).toContain("bytes omitted by the result ceiling");
    }
  });
});

describe("uris", () => {
  test("escape a pane id so its % does not read as an escape", () => {
    expect(paneContentUri("%1")).toBe("tmux://panes/%251/content");
  });
});
