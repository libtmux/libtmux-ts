/**
 * The `tmux://` namespace, in one place.
 *
 * Resources and the links tools hand back have to agree on these strings, and a
 * link that does not resolve is worse than no link: the agent spends a call
 * finding out.
 */

export const CAPABILITIES_URI = "tmux://capabilities";
