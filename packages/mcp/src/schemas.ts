import { z } from "zod";

import { PANE_CURSOR_PATTERN } from "./live.js";

/** Shared wire contracts for identifiers accepted by MCP tools. */
export const paneIdSchema = z
  .string()
  .regex(/^%\d+$/u, "Expected a pane id such as %1.")
  .describe("Stable pane id, e.g. %1.");

export const windowIdSchema = z
  .string()
  .regex(/^@\d+$/u, "Expected a window id such as @1.")
  .describe("Stable window id, e.g. @1.");

export const paneCursorSchema = z
  .string()
  .regex(PANE_CURSOR_PATTERN, "Expected a cursor returned by observe or wait_for_text.");
