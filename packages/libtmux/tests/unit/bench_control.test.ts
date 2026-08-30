import { expect, test } from "bun:test";

import { OUTPUT_MARKER, OutputMarkerTracker } from "../../scripts/bench-control.js";

test.each([
  { chunks: [`xxxx${OUTPUT_MARKER}`], expected: 4, name: "a whole marker" },
  {
    chunks: [`xxxx${OUTPUT_MARKER.slice(0, -3)}`, OUTPUT_MARKER.slice(-3)],
    expected: 4,
    name: "a split marker",
  },
  {
    chunks: [`xxxx${OUTPUT_MARKER}\ntrailing`],
    expected: 4,
    name: "trailing bytes",
  },
  { chunks: [`xxx${OUTPUT_MARKER}`], expected: 3, name: "a short payload" },
])("finds $name at its payload boundary", ({ chunks, expected }) => {
  const tracker = new OutputMarkerTracker();
  let actual: number | undefined;
  for (const chunk of chunks) {
    actual = tracker.push(chunk);
    if (actual !== undefined) break;
  }
  expect(actual).toBe(expected);
});

test("counts bytes when the marker is absent", () => {
  const tracker = new OutputMarkerTracker();
  expect(tracker.push("xxxx")).toBeUndefined();
  expect(tracker.receivedBytes).toBe(4);
});
