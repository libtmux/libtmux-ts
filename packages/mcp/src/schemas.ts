import { z } from "zod";

import { PANE_CURSOR_PATTERN } from "./live.js";

/** Shared wire contracts for identifiers accepted by MCP tools. */
export const paneCursorSchema = z
  .string()
  .regex(PANE_CURSOR_PATTERN, "Expected a cursor returned by observe or wait_for_text.");
