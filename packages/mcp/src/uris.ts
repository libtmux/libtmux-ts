/**
 * The `tmux://` namespace, in one place.
 *
 * Resources and the links tools hand back have to agree on these strings, and a
 * link that does not resolve is worse than no link: the agent spends a call
 * finding out.
 */

export const SESSIONS_URI = "tmux://sessions";
export const PANES_URI = "tmux://panes";
export const WINDOWS_URI = "tmux://windows";
export const CLIENTS_URI = "tmux://clients";

export function sessionUri(sessionId: string): string {
  return `${SESSIONS_URI}/${encodeURIComponent(sessionId)}`;
}

export function windowUri(windowId: string): string {
  return `${WINDOWS_URI}/${encodeURIComponent(windowId)}`;
}

export function paneUri(paneId: string): string {
  return `${PANES_URI}/${encodeURIComponent(paneId)}`;
}

export function paneContentUri(paneId: string): string {
  return `${paneUri(paneId)}/content`;
}
