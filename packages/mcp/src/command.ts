/**
 * Running a shell command in a pane and knowing exactly what it printed.
 *
 * The problem this solves is the echo. A pane repeats what is typed into it, so
 * a wait for text that also appears in the command matches the echo at once and
 * reports the command's own text as its output. Waiting for a marker does not
 * help by itself: the marker is in the command, so it is echoed too.
 *
 * The fix is to make the marker unspeakable. The command carries `${m}_S`, and
 * the shell prints `<id>_S`; the two are the same string only after expansion,
 * so the literal never appears in what is typed and a match on it is always the
 * printed one. Nothing here depends on the shell beyond `printf` and `$?`.
 */

import { randomUUID } from "node:crypto";

import type { Pane } from "libtmux";

import type { ToolContext } from "./context.js";
import { effectiveWaitMs } from "./policy.js";

export interface FramedResult {
  readonly effectiveTimeoutMs: number;
  readonly exitStatus: number | null;
  /** Another writer was seen in this command's own output. */
  readonly foreignOutputSuspected: boolean;
  readonly outcome: "completed" | "pane_died" | "timed_out";
  readonly output: string;
}

/** How far back a fallback capture reads, so a marker that scrolled is still found. */
const FALLBACK_SCROLLBACK = 400;

/** How often the fallback re-reads the pane when no stream is available. */
const FALLBACK_POLL_MS = 60;

/**
 * Wrap a command so its output can be told from the pane's echo of it.
 *
 * The leading space is what keeps the command out of the history file of a
 * shell set to HIST_IGNORE_SPACE or HISTCONTROL=ignorespace. It used to be
 * skipped for a multiline command, which is exactly the shape a here-doc or a
 * pasted block takes — so the one case most likely to carry a secret was the
 * one case that persisted it to disk. Both shells record a multiline buffer as
 * a single history entry, so the space suppresses it the same way; verified
 * against zsh with the option set, where the spaced form is absent from the
 * file and the unspaced form is written in full.
 */
export function frame(command: string, id: string, suppressHistory: boolean): string {
  const multiline = command.includes("\n") || command.includes("\r");
  const prefix = suppressHistory ? " " : "";
  const open = `${prefix}m=${id}; printf '%s\\n' "\${m}_S"; (`;
  const close = `); s=$?; printf '%s %s\\n' "\${m}_E" "$s"`;
  return multiline
    ? `${open}\n${command.replace(/\s+$/, "")}\n${close}`
    : `${open} ${command} ${close}`;
}

/** A framing marker: `<id>_S` or `<id>_E`, as the shell prints it. */
const MARKER = /\b(ltx[0-9a-f]+)_([SE])\b/u;
/** A framing command, as the pane echoes it back when somebody types one. */
const FRAMING_ECHO = /(?:^|\s)m=(ltx[0-9a-f]+);/u;

/**
 * Remove another caller's framing, and its output, from this caller's body.
 *
 * Ids are unique, so no run ever matches another's markers — but the body
 * between one run's markers is everything the pane printed meanwhile, which on
 * a shared pane includes a second caller's echoed command and its output. That
 * is not noise: a command carries whatever the other agent put in it, so the
 * result of one call disclosed the input of another. Every agent CLI on a
 * machine can point at one server, which makes two callers on one pane the
 * ordinary case rather than a contrived one.
 *
 * A pane is single-writer and nothing here can lock it across processes, so
 * this cleans the report rather than preventing the overlap — and it cannot
 * clean all of it. A foreign run that started before this one and printed
 * during it leaves output with no marker anywhere in this body, textually
 * indistinguishable from this command's own; a foreign run still going when
 * this one ends leaves output that cannot be bracketed. Dropping to the end of
 * the body on an unterminated marker would take this caller's real output with
 * it, so the choice is between silently returning someone else's output and
 * silently returning a hole. It reports instead: `foreignOutputSuspected` says
 * another writer was seen in this body. False is not proof of cleanliness —
 * only that no foreign marker appeared here.
 */
export function withoutForeignFraming(
  body: string,
  id: string,
): { readonly foreignOutputSuspected: boolean; readonly text: string } {
  const lines = body.split("\n");
  const foreign = (value: string): boolean => value !== id;

  // A foreign run whose start and end are both here brackets that run's own
  // output, which belongs to its caller. An unterminated one is left alone:
  // dropping to the end of the body would take this caller's output with it.
  const drop = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const start = MARKER.exec(line);
    if (start?.[2] !== "S" || !foreign(start[1] ?? "")) continue;
    const closes = lines.findIndex(
      (later, at) => at > index && later.includes(`${start[1] ?? ""}_E`),
    );
    if (closes < 0) continue;
    for (let at = index; at <= closes; at += 1) drop.add(at);
  }

  let seen = drop.size > 0;
  const kept = lines.filter((line, index) => {
    if (drop.has(index)) return false;
    const echo = FRAMING_ECHO.exec(line);
    if (echo !== null && foreign(echo[1] ?? "")) {
      seen = true;
      return false;
    }
    const marker = MARKER.exec(line);
    if (marker !== null && foreign(marker[1] ?? "")) {
      seen = true;
      return false;
    }
    return true;
  });

  return { foreignOutputSuspected: seen, text: kept.join("\n") };
}

/** Pull the command's own output out of the framed stream. */
function slice(
  stream: string,
  id: string,
): { exitStatus: number | null; foreignOutputSuspected: boolean; output: string } | undefined {
  const startAt = stream.indexOf(`${id}_S`);
  if (startAt < 0) return undefined;
  const endAt = stream.indexOf(`${id}_E`, startAt);
  if (endAt < 0) return undefined;

  const afterStart = stream.indexOf("\n", startAt);
  const body = afterStart < 0 || afterStart > endAt ? "" : stream.slice(afterStart + 1, endAt);
  const statusLine = stream.slice(endAt).split("\n", 1)[0] ?? "";
  const parsed = Number.parseInt(statusLine.slice(`${id}_E`.length).trim(), 10);

  // The end marker is printed on its own line, so the body ends with the
  // newline that preceded it; trailing CR comes from the pty, not the command.
  const cleaned = withoutForeignFraming(body.replace(/\r?\n?$/, "").replaceAll("\r\n", "\n"), id);

  return {
    exitStatus: Number.isFinite(parsed) ? parsed : null,
    foreignOutputSuspected: cleaned.foreignOutputSuspected,
    output: cleaned.text,
  };
}

/**
 * Run `command` in `pane` and wait for it to finish.
 *
 * Streams tmux's notifications when a control connection can be had, and falls
 * back to re-reading the pane when it cannot — the framing makes both correct,
 * so the difference is cost rather than accuracy.
 */
export async function runFramedCommand(
  context: ToolContext,
  pane: Pane,
  command: string,
  timeoutMs: number | undefined,
  asTask: boolean,
  signal?: AbortSignal,
  suppressHistory = true,
): Promise<FramedResult> {
  const budget = effectiveWaitMs(context.policy, timeoutMs, asTask);
  const id = `ltx${randomId()}`;
  const payload = frame(command, id, suppressHistory);
  const sessionId = pane.sessionId;

  const tail =
    context.policy.liveEnabled && sessionId !== null
      ? await context.hub.tail(sessionId, pane.id)
      : undefined;

  // Read the stream position before sending: output printed between the send
  // and the first read would otherwise be attributed to whatever came before.
  const cursor = tail?.cursor;
  await pane.sendKeys(payload, { literal: true });

  const deadline = Date.now() + budget;
  while (Date.now() < deadline && signal?.aborted !== true) {
    const stream =
      tail === undefined
        ? // eslint-disable-next-line no-await-in-loop -- each read follows the last.
          (await pane.capture({ start: -FALLBACK_SCROLLBACK }).catch(() => [])).join("\n")
        : tail.read(cursor).text;
    const found = slice(stream, id);
    if (found !== undefined) {
      return { effectiveTimeoutMs: budget, ...found, outcome: "completed" };
    }
    // eslint-disable-next-line no-await-in-loop -- the wait follows its read.
    await (tail === undefined
      ? new Promise((resolve) => setTimeout(resolve, FALLBACK_POLL_MS))
      : tail.changed(Math.min(FALLBACK_POLL_MS * 4, Math.max(1, deadline - Date.now())), signal));
  }

  // Timed out, or the pane died under it — which is a different answer, and the
  // only one where calling again would wait on something that cannot arrive.
  const partial =
    tail === undefined
      ? (await pane.capture({ start: -FALLBACK_SCROLLBACK }).catch(() => [])).join("\n")
      : tail.read(cursor).text;
  const startAt = partial.indexOf(`${id}_S`);
  const afterStart = startAt < 0 ? -1 : partial.indexOf("\n", startAt);
  const output = afterStart < 0 ? partial : partial.slice(afterStart + 1);
  // The same cleaning as the completed path: a command that timed out has been
  // sharing the pane for longer, not less.
  const cleaned = withoutForeignFraming(output.replaceAll("\r\n", "\n"), id);

  const alive = (await context.snapshot()).panes.exists({ id: pane.id });
  return {
    effectiveTimeoutMs: budget,
    exitStatus: null,
    foreignOutputSuspected: cleaned.foreignOutputSuspected,
    outcome: alive ? "timed_out" : "pane_died",
    output: cleaned.text,
  };
}

/**
 * A short id, unique enough that no run matches another's markers.
 *
 * That is a weaker guarantee than it sounds: matching is safe, attribution is
 * not. The body between one run's markers is whatever the pane printed, so
 * uniqueness keeps two runs from reading each other's *markers*, not from
 * reading each other's *output*.
 *
 * Letters and digits only: the id is pasted into a shell word, so anything a
 * shell would treat as syntax cannot appear in it.
 */
export function randomId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}
