/**
 * What this server has typed into a pane that `wait_for_text` must not mistake
 * for the pane's own output.
 *
 * A pane echoes what is typed into it. A wait that watches for text a caller
 * just sent — `send_keys(paneId, "echo MARKER", enter: true)` then a wait for
 * `MARKER` — would otherwise be answered by that echo, before the command has
 * done anything. Nothing about *when* the echo arrives sets it apart from real
 * output, so it is told apart by *what it is*: the exact text this process
 * itself dispatched, tracked here as it is typed and discounted while a wait
 * is deciding whether something matched.
 *
 * Two pieces, matching the two ways typed text stops being "just typed":
 *
 * - `pending` is the line still being edited — built up key by key, corrected
 *   by a backspace, abandoned by a kill, all before anything is submitted.
 * - `recent` is what a line became once it ended (submitted or killed), kept
 *   for a bounded time so a wait that is still reading the same buffered bytes
 *   does not stop discounting a line's echo just because some wall-clock time
 *   has passed since it was sent.
 *
 * Keyed by pane id *and* server identity: a pane id tmux hands out again after
 * a restart must not inherit an old generation's record.
 */

/** The tmux daemon a record belongs to — enough to tell one generation from the next. */
export interface PaneServerIdentity {
  readonly pid: string;
  readonly socketPath: string;
  readonly startTime: string;
}

function identityKey(identity: PaneServerIdentity): string {
  return `${identity.socketPath}\u0000${identity.pid}\u0000${identity.startTime}`;
}

/**
 * Long enough to cover ordinary latency between submitting a line and a wait
 * still reading its buffered echo; short enough that a pane reused for
 * something else is not stuck discounting an old line indefinitely.
 */
const RECENT_TTL_MS = 10_000;

/** A command and the keys that submit it, with room to spare; the oldest is dropped. */
const RECENT_CAP = 4;

interface RecentEcho {
  readonly atMs: number;
  readonly text: string;
}

interface PaneEchoState {
  readonly identityKey: string;
  pending: string;
  /**
   * Whether `pending`'s longest length so far this edit already has a
   * `recent` entry protecting it. A shell that erases by redrawing the whole
   * line (`\r` plus the shorter content, which `TextFilter` turns into a new
   * line) leaves the pre-erase text sitting in the tail as its own line,
   * unaffected by anything a later edit does to `pending` — so an erase that
   * would otherwise be the first to shrink past a length nothing has captured
   * yet banks that longer value in `recent` before it does.
   */
  pendingCaptured: boolean;
  recent: RecentEcho[];
}

const byPane = new Map<string, PaneEchoState>();

/**
 * The live record for `paneId` under `identity`, discarding whatever was
 * there if it belongs to an earlier server generation.
 */
function stateFor(paneId: string, identity: PaneServerIdentity): PaneEchoState {
  const key = identityKey(identity);
  const existing = byPane.get(paneId);
  if (existing !== undefined && existing.identityKey === key) return existing;
  const fresh: PaneEchoState = {
    identityKey: key,
    pending: "",
    pendingCaptured: false,
    recent: [],
  };
  byPane.set(paneId, fresh);
  return fresh;
}

function pruneRecent(state: PaneEchoState, nowMs: number): void {
  if (state.recent.length === 0) return;
  state.recent = state.recent.filter((entry) => nowMs - entry.atMs <= RECENT_TTL_MS);
}

function pushRecent(state: PaneEchoState, text: string, nowMs: number): void {
  if (text === "") return;
  pruneRecent(state, nowMs);
  state.recent.push({ atMs: nowMs, text });
  if (state.recent.length > RECENT_CAP) {
    state.recent.splice(0, state.recent.length - RECENT_CAP);
  }
}

/** A line ends: whatever was pending moves to `recent`, and pending resets. */
function endLine(state: PaneEchoState, nowMs: number): void {
  pushRecent(state, state.pending, nowMs);
  state.pending = "";
  state.pendingCaptured = false;
}

function dropLastCodePoint(text: string): string {
  if (text === "") return text;
  const codePoints = Array.from(text);
  codePoints.pop();
  return codePoints.join("");
}

// -- key classification --------------------------------------------------
//
// The reference model is libtmux-go's `pending_input.go`: submit, kill-line,
// erase and a forward-delete no-op. Diverges from it in one place, called out
// where it happens.

const SUBMIT_KEYS = new Set(["C-m", "Enter", "KPEnter"]);
const KILL_LINE_KEYS = new Set(["C-c", "C-u"]);
const ERASE_KEYS = new Set(["BSpace", "C-h"]);
const NOOP_KEYS = new Set(["DC"]);

/**
 * Key names tmux recognizes that this classifier does not model at all —
 * arrow and navigation keys, function keys, and any other `C-`/`M-`/`S-`
 * combination beyond the ones above.
 *
 * libtmux-go's model leaves a pane's tracked line untouched here. This port
 * clears it instead: a key that moves the cursor or edits some other way
 * means the tracked text no longer reliably describes what is on the line,
 * and continuing to mask it risks hiding real output that later happens to
 * repeat that stale text — worse than simply forgetting it.
 */
const UNHANDLED_KEY_NAME =
  /^(?:BTab|Down|End|Escape|F(?:[1-9]|1[0-9]|2[0-4])|Home|IC|Left|NPage|PPage|PageDown|PageUp|Right|Tab|Up)$/u;
const CONTROL_OR_META_COMBO = /^(?:C|M|S)(?:-(?:C|M|S))*-./u;

type KeyEffect =
  | { readonly kind: "erase" }
  | { readonly kind: "kill" }
  | { readonly kind: "noop" }
  | { readonly kind: "submit" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unknown" };

/**
 * What one non-literal `send_keys` token does to the line being built.
 *
 * A token that is not one of the named keys below is exactly what tmux itself
 * does with it when it does not match its key table: literal text, sent
 * character by character. Modelling that fallback, rather than requiring
 * every token to be a single character, is the one place this necessarily
 * diverges from a per-rune key model — ts's `send_keys` takes one string, not
 * an array of individual keys, so an ordinary word or line arrives as a single
 * non-literal token.
 */
function classifyKey(key: string): KeyEffect {
  if (SUBMIT_KEYS.has(key)) return { kind: "submit" };
  if (KILL_LINE_KEYS.has(key)) return { kind: "kill" };
  if (ERASE_KEYS.has(key)) return { kind: "erase" };
  if (NOOP_KEYS.has(key)) return { kind: "noop" };
  if (key === "Space") return { kind: "text", text: " " };
  if (Array.from(key).length === 1) return { kind: "text", text: key };
  if (UNHANDLED_KEY_NAME.test(key) || CONTROL_OR_META_COMBO.test(key)) return { kind: "unknown" };
  return { kind: "text", text: key };
}

function applyEffect(state: PaneEchoState, effect: KeyEffect, nowMs: number): void {
  switch (effect.kind) {
    case "submit":
    case "kill":
      endLine(state, nowMs);
      return;
    case "erase":
      // The pre-erase value is the longest this edit has reached; capture it
      // once, before shrinking, so a shell's redraw-by-`\r` echo of it stays
      // discounted even after `pending` no longer says it.
      if (!state.pendingCaptured) {
        pushRecent(state, state.pending, nowMs);
        state.pendingCaptured = true;
      }
      state.pending = dropLastCodePoint(state.pending);
      return;
    case "noop":
      return;
    case "unknown":
      // Fails open: nothing about this line is carried into `recent`, so a
      // wait stops discounting it rather than keeping a capture that may no
      // longer describe what is really on the pane's line.
      state.pending = "";
      state.pendingCaptured = false;
      return;
    case "text":
      state.pending += effect.text;
      // A longer value than anything captured so far; the next erase (if any)
      // must capture it again rather than reuse a shorter, stale capture.
      state.pendingCaptured = false;
  }
}

/** Record one non-literal key-name dispatch: `send_keys`, a batch step, a cohort write. */
export function noteKeyDispatch(
  paneId: string,
  identity: PaneServerIdentity,
  keys: string,
  enter: boolean,
): void {
  const state = stateFor(paneId, identity);
  const now = Date.now();
  applyEffect(state, classifyKey(keys), now);
  if (enter) endLine(state, now);
}

/** Record one literal write: `send_keys` with `literal: true`, or `paste_text`. */
export function noteLiteralWrite(
  paneId: string,
  identity: PaneServerIdentity,
  text: string,
  enter: boolean,
): void {
  const state = stateFor(paneId, identity);
  const now = Date.now();
  const whole = text + (enter ? "\n" : "");
  state.pending += whole;
  state.pendingCaptured = false;
  // An embedded newline submits everything up to it the moment tmux takes it;
  // nothing distinguishes an earlier line inside the same write from one sent
  // on its own, so the whole write becomes one discounted unit rather than
  // being split line by line.
  if (whole.includes("\n") || whole.includes("\r")) endLine(state, now);
}

/** Bound memory: drop any pane's record once it is no longer among `livePaneIds`. */
export function pruneDeadPanes(livePaneIds: ReadonlySet<string>): void {
  for (const paneId of byPane.keys()) {
    if (!livePaneIds.has(paneId)) byPane.delete(paneId);
  }
}

export interface LiveEcho {
  /** Lines this pane finished within {@link RECENT_TTL_MS}, oldest first. */
  readonly recent: readonly string[];
  /** The line still being edited, or `""` if there is none. */
  readonly pending: string;
}

const NO_ECHO: LiveEcho = { pending: "", recent: [] };

/**
 * What this server has typed into `paneId`, under `identity`, that a wait
 * should discount right now.
 *
 * Returns nothing for a record left by a different server generation: a pane
 * id tmux hands out again after a restart carries no memory forward.
 */
export function liveEcho(paneId: string, identity: PaneServerIdentity): LiveEcho {
  const state = byPane.get(paneId);
  if (state === undefined || state.identityKey !== identityKey(identity)) return NO_ECHO;
  pruneRecent(state, Date.now());
  return { pending: state.pending, recent: state.recent.map((entry) => entry.text) };
}

// -- whole-occurrence removal ---------------------------------------------

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * Remove every standalone occurrence of `echo` from `text`.
 *
 * An occurrence counts only where it is not part of a longer run of word
 * characters on either side — what tells a short typed answer apart from a
 * longer word that merely contains it: `y` comes off `$ y` and stays inside
 * `ready`. This is what lets a whole recorded line (`echo MARKER`) be removed
 * as the exact thing that was typed, without also erasing an unrelated later
 * line whose real output happens to repeat one of its words.
 */
export function withoutEcho(text: string, echo: string): string {
  if (echo === "" || text === "") return text;
  let result = "";
  let cursor = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(echo, from);
    if (at === -1) break;
    const end = at + echo.length;
    const opens = at === 0 || !isWordChar(text[at - 1]) || !isWordChar(echo[0]);
    const closes =
      end === text.length || !isWordChar(text[end]) || !isWordChar(echo[echo.length - 1]);
    if (opens && closes) {
      result += text.slice(cursor, at);
      cursor = end;
      from = end;
    } else {
      from = at + 1;
    }
  }
  return result + text.slice(cursor);
}

/** {@link withoutEcho}, applied for every text in `echoes`. */
export function withoutEchoes(text: string, echoes: Iterable<string>): string {
  let result = text;
  for (const echo of echoes) {
    if (echo !== "") result = withoutEcho(result, echo);
  }
  return result;
}
