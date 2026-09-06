import type { CallerEnvironment } from "./caller.js";
import type { Policy } from "./policy.js";

const MAX_BYTES = 3072;

const SHARED = `libtmux MCP server. tmux hierarchy: Server > Session > Window > Pane.
Target panes by id (%1); ids survive renames and layout changes.

Only tools advertised by tools/list are callable. Toolsets are unordered capability
groups, not authorization levels. MCP annotations are conservative consent metadata,
not enforcement. tmux://capabilities reports the frozen effective surface, direct
process reach, tmux effects, output classes, input sinks, and selected socket.`;

export function buildInstructions(
  policy: Policy,
  caller?: CallerEnvironment,
  effectiveTools: ReadonlySet<string> = policy.tools,
): string {
  const selection =
    effectiveTools.size === 0
      ? "No structured tools are enabled."
      : `${String(effectiveTools.size)} structured tools are enabled.`;
  const live = policy.liveEnabled
    ? "Live observation is enabled."
    : "Live observation is disabled by LIBTMUX_MCP_LIVE=0.";
  const own =
    caller?.paneId === undefined
      ? ""
      : ` This process was launched from tmux pane ${caller.paneId}; direct write and teardown tools retain their self-target guard.`;
  const text = `${SHARED}\n\n${selection} ${live}${own}`;
  return Buffer.byteLength(text, "utf8") <= MAX_BYTES ? text : SHARED;
}

export function instructionsBudget(): { readonly limit: number; readonly used: number } {
  return { limit: MAX_BYTES, used: Buffer.byteLength(SHARED, "utf8") };
}
