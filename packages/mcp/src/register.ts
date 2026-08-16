/**
 * How a tool declares what it costs a caller to be wrong about it.
 *
 * MCP annotations are how a host decides what to auto-approve, and the safety
 * tier is how an operator decides what to offer at all. Both are properties of
 * the tool rather than of the call, so they are declared once beside it.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { tierAllows, type Policy, type SafetyTier } from "./policy.js";

/** Reads state, changes nothing, and can be called again for free. */
export const READ_ONLY: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

/** Changes tmux state, but nothing a later call cannot put back. */
export const MUTATING: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

/** Ends something: a session, a window, a pane, a process. */
export const DESTRUCTIVE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

/**
 * Runs something whose effect is outside tmux.
 *
 * `send_keys` types into a shell, so what it does is whatever that shell does —
 * unknowable from here, which is what `openWorldHint` says.
 */
export const OPEN_WORLD: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
};

export function offers(policy: Policy, tier: SafetyTier): boolean {
  return tierAllows(policy.safety, tier);
}
