import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OPTION_SCOPE,
  HOOK_SCOPE_FLAG_MAP,
  OptionScope,
  OPTION_SCOPE_FLAG_MAP,
  PaneDirection,
  PANE_DIRECTION_FLAG_MAP,
  ResizeAdjustmentDirection,
  RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP,
  WindowDirection,
  WINDOW_DIRECTION_FLAG_MAP,
} from "../../src/constants.js";

describe("constants", () => {
  test("preserve Python direction member names and values", () => {
    expect(ResizeAdjustmentDirection).toEqual({
      Down: "DOWN",
      Left: "LEFT",
      Right: "RIGHT",
      Up: "UP",
    });
    expect(WindowDirection).toEqual({ After: "AFTER", Before: "BEFORE" });
    expect(PaneDirection).toEqual({ Above: "ABOVE", Below: "BELOW", Left: "LEFT", Right: "RIGHT" });
  });

  test("uses the same option-scope values as operations", () => {
    expect(OptionScope).toEqual({
      Pane: "pane",
      Server: "server",
      Session: "session",
      Window: "window",
    });
  });

  test("maps every direction and scope to its tmux flag", () => {
    expect(RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP).toEqual({
      DOWN: "-D",
      LEFT: "-L",
      RIGHT: "-R",
      UP: "-U",
    });
    expect(WINDOW_DIRECTION_FLAG_MAP).toEqual({ AFTER: "-a", BEFORE: "-b" });
    expect(PANE_DIRECTION_FLAG_MAP).toEqual({
      ABOVE: ["-v", "-b"],
      BELOW: ["-v"],
      LEFT: ["-h", "-b"],
      RIGHT: ["-h"],
    });
    expect(OPTION_SCOPE_FLAG_MAP).toEqual({ pane: "-p", server: "-s", session: "", window: "-w" });
    expect(HOOK_SCOPE_FLAG_MAP).toEqual({ pane: "-p", server: "-g", session: "", window: "-w" });
    expect(DEFAULT_OPTION_SCOPE).toBe(DEFAULT_OPTION_SCOPE);
  });
});
