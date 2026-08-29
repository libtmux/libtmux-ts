/**
 * What the server tells a client about itself at handshake.
 *
 * This is the only text every model sees before choosing a tool, so it carries
 * what a wrong choice costs rather than what the tools are named — a list of
 * names is already in `tools/list`.
 */

import type { CallerEnvironment } from "./caller.js";
import type { Policy } from "./policy.js";

/**
 * A ceiling on the text, so an added paragraph fails here rather than crowding
 * out the paragraph that stops an agent typing into somebody's terminal.
 */
const MAX_BYTES = 3072;

const RESOURCES_ONLY = (
  policy: Policy,
): string => `libtmux MCP server. No tools are enabled by LIBTMUX_MCP_TOOLS.
Unset it to offer every tool permitted by LIBTMUX_SAFETY, or set it to a
comma-separated allowlist. MCP resources remain available for browsing${policy.liveEnabled ? " and subscriptions" : ""}.`;

const ALLOWLISTED = (policy: Policy): string => `LIBTMUX_MCP_TOOLS is set. Use only tools
advertised by tools/list; the ${policy.safety} tier is the ceiling and the allowlist
may narrow it.`;

const SHARED = `libtmux MCP server. tmux hierarchy: Server > Session > Window > Pane.
Target panes by id (%1) — ids survive renames and layout changes; names do not.

TRIGGERS: tmux objects — panes, windows, sessions, splits, scrollback, copy mode.
Bare "pane", "split", "this terminal", "send keys" mean tmux here. Ids are
unambiguous: % pane, @ window, $ session.
ANTI-TRIGGERS: browser tabs, editor splits (VS Code, Neovim), GUI windows (i3,
sway), Jupyter cells, login or HTTP sessions. Ask once if a bare "window" or
"session" could be either.`;

const METADATA = `METADATA vs CONTENT: list_sessions/list_windows/list_panes search metadata only.
For what a pane shows or mentions, use capture_pane, observe, or search_panes.`;

const FULL_WAIT = `WAIT, DON'T POLL. Never loop send_keys + capture_pane.
- run_command: your own shell command, waited to completion, with exit status.
  Prefer it. It frames the command so a pane's echo cannot be mistaken for
  output, which a capture loop gets wrong every time.`;

const READONLY_WAIT = `WAIT, DON'T POLL. Never loop capture_pane.`;

const WAIT_READERS = `- wait_for_text: output you did not author — another process, a human, a job.
- observe: repeated reading. Keep the returned cursor and pass it back; you are
  then told only what arrived since, not the whole screen again.
Waits stream tmux's own notifications; they cost no commands while waiting.
Every wait is clamped, and its result reports the timeout it actually used.`;

const WAIT_END = `NEVER STUCK: a wait that does not match still returns what the pane printed, its
state, and what to try next. Read the outcome field rather than retrying blind.`;

const LIVE_RESOURCES = `RESOURCES: tmux://sessions, tmux://panes/{id}, tmux://panes/{id}/content are
browsable and subscribable. Large captures come back as links — read the link
only if you need the whole thing.`;

const STATIC_RESOURCES = `RESOURCES: tmux://sessions, tmux://panes/{id}, tmux://panes/{id}/content are
browsable. Large captures come back as links — read the link only if you need
the whole thing.`;

const NO_LIVE = `Live streaming is disabled by LIBTMUX_MCP_LIVE=0. observe returns a
current capture without waiting or a reusable cursor.`;

const FULL_CORE = `${SHARED}\n\n${METADATA}\n\n${FULL_WAIT}\n${WAIT_READERS}\n\n${WAIT_END}\n\n${LIVE_RESOURCES}`;
const READONLY_CORE = `${SHARED}\n\n${METADATA}\n\n${READONLY_WAIT}\n${WAIT_READERS}\n\n${WAIT_END}\n\n${LIVE_RESOURCES}`;
const FULL_NO_LIVE = `${SHARED}\n\n${METADATA}\n\n${FULL_WAIT}\n\n${NO_LIVE}\n\n${STATIC_RESOURCES}`;
const READONLY_NO_LIVE = `${SHARED}\n\n${METADATA}\n\n${NO_LIVE}\n\n${STATIC_RESOURCES}`;

/**
 * Build the instructions for this process's configuration.
 *
 * Only what stays true for the life of the process goes in here. Who is
 * attached and what they are watching changes while the server runs, so the
 * text describes the protection boundary without freezing current attachments.
 */
export function buildInstructions(policy: Policy, caller?: CallerEnvironment): string {
  if (policy.tools?.size === 0) return RESOURCES_ONLY(policy);

  const allowlisted = policy.tools !== undefined;
  const resources = policy.liveEnabled ? LIVE_RESOURCES : STATIC_RESOURCES;
  const core = policy.liveEnabled
    ? policy.safety === "readonly"
      ? READONLY_CORE
      : FULL_CORE
    : policy.safety === "readonly"
      ? READONLY_NO_LIVE
      : FULL_NO_LIVE;
  const parts = [allowlisted ? `${SHARED}\n\n${ALLOWLISTED(policy)}\n\n${resources}` : core];

  if (!allowlisted) {
    parts.push(
      `\n\nSafety: ${policy.safety} (readonly | mutating | destructive). Set LIBTMUX_SAFETY; off-tier tools are not listed.`,
    );
    if (policy.safety === "readonly") {
      parts.push(" Reading is free here — probe list_panes or search_panes rather than asking.");
    }
  }

  const base = parts.join("");
  if (caller?.paneId === undefined) return base;

  const own = allowlisted
    ? `\n\nThis process was launched from tmux pane ${caller.paneId}. The server refuses to write to or kill that pane only when it belongs to the served tmux server, and refuses to write to or kill a pane a person is watching, unless explicitly overridden.`
    : `\n\nYou are running inside tmux pane ${caller.paneId}. Call whoami before writing to any` +
      ` pane you did not create: it says whether that pane is on the server you drive, and which` +
      ` panes a person is watching. Results mark both as isCallerPane and isAttended.`;
  const combined = base + own;
  return Buffer.byteLength(combined, "utf8") <= MAX_BYTES ? combined : base;
}

/** Whether the core text still fits, checked by a test rather than at startup. */
export function instructionsBudget(): { readonly limit: number; readonly used: number } {
  return { limit: MAX_BYTES, used: Buffer.byteLength(FULL_CORE, "utf8") };
}
