/**
 * Running a shell command in a pane and knowing exactly what it printed.
 *
 * The problem this solves is the echo. A pane repeats what is typed into it, so
 * a wait for text that also appears in the command matches the echo at once and
 * reports the command's own text as its output. Waiting for a marker does not
 * help by itself: the marker is in the command, so it is echoed too.
 *
 * The wrapper keeps the marker in an outer subshell, then removes it from the
 * command subshell before evaluating the caller's text. It also disables
 * inherited tracing and errexit before the marker exists. The function has no
 * arguments, so Bash's extended debug state cannot retain the marker after the
 * command clears its ordinary parameters. Nothing escapes the outer subshell.
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
  /** Output that fell out of the pane's buffer before this read reached it. */
  readonly missedBytes: number;
  readonly outcome: "completed" | "pane_died" | "timed_out";
  readonly output: string;
  /** False when the start marker was gone and the returned output starts partway through. */
  readonly outputComplete: boolean;
  /** Settles when the wrapper ends or the pane can no longer run it. */
  readonly settled: Promise<void>;
}

export interface FramedCommandReservation {
  release(): void;
  settleWith(settled: Promise<void>): void;
}

const activeCommands = new WeakMap<ToolContext, Map<string, Map<symbol, string>>>();

/** Describe the first unfinished command this server started in a pane. */
export function activeFramedCommand(context: ToolContext, paneId: string): string | undefined {
  return activeCommands.get(context)?.get(paneId)?.values().next().value;
}

/** Reserve a pane until the command's framing proves that it settled. */
export function reserveFramedCommand(
  context: ToolContext,
  paneId: string,
  command: string,
): FramedCommandReservation {
  const byPane = activeCommands.get(context) ?? new Map<string, Map<symbol, string>>();
  const commands = byPane.get(paneId) ?? new Map<symbol, string>();
  const token = Symbol(paneId);
  commands.set(token, JSON.stringify(command.slice(0, 80)));
  byPane.set(paneId, commands);
  activeCommands.set(context, byPane);

  const release = (): void => {
    commands.delete(token);
    if (commands.size === 0) byPane.delete(paneId);
    if (byPane.size === 0) activeCommands.delete(context);
  };
  return {
    release,
    settleWith: (settled) => {
      void settled.then(release, () => undefined);
    },
  };
}

/** How far back a fallback capture reads, so a marker that scrolled is still found. */
const FALLBACK_SCROLLBACK = 400;

/** How often the fallback re-reads the pane when no stream is available. */
const FALLBACK_POLL_MS = 60;

/** How often an already-returned command checks a streamless pane. */
const SETTLEMENT_POLL_MS = 1_000;

/** How often settlement confirms that a quiet pane still exists. */
const SETTLEMENT_LIVENESS_MS = 5_000;

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
  const prefix = suppressHistory ? " " : "";
  const scope = `__ltx_${randomId()}`;
  const marker = `${scope}_marker`;
  const options = `${scope}_options`;
  const normalized = command.replace(/\r\n?/gu, "\n");
  const quoted = `'${normalized.replaceAll("'", `'\\''`)}'`;
  return (
    `${prefix}( ${options}=$-; set +x; set +e; ${marker}=${id}; ` +
    `${scope}() { printf '%s\\n' "\${${marker}}_S"; ` +
    `( unset ${marker}; set --; ` +
    `case "\${${options}}" in *e*) set -e;; esac; ` +
    `case "\${${options}}" in *x*) set -x;; esac; ` +
    `unset ${options}; eval ${quoted} ); ` +
    `printf '%s %s\\n' "\${${marker}}_E" "$?"; }; ${scope} )`
  );
}

/** A framing marker: `<id>_S` or `<id>_E`, as the shell prints it. */
const MARKER = /\b(ltx[0-9a-f]+)_([SE])\b/u;
/** A framing command, as the pane echoes it back when somebody types one. */
const FRAMING_ECHO = /(?:^|\s)__ltx_[0-9a-f]+\(\)/u;

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
    if (echo !== null) {
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

/**
 * Pull the command's own output out of the framed stream.
 *
 * The end marker says the wrapper finished and carries its status. Its random
 * value is unavailable through the command's inherited shell state; this is
 * framing, not a sandbox against code that can inspect the tmux server itself.
 * The start marker is only needed to locate where the body begins — and it is
 * printed first, so it is the first thing lost, whether to the tail's byte
 * limit or to a fallback capture that samples the last few hundred lines.
 * Requiring it meant a command that outran either bound ran to its deadline and
 * was reported as still running after it had already finished, which is worse
 * than reporting it finished with output that starts partway through.
 */
function slice(
  stream: string,
  id: string,
):
  | {
      exitStatus: number | null;
      foreignOutputSuspected: boolean;
      output: string;
      outputComplete: boolean;
    }
  | undefined {
  const startAt = stream.indexOf(`${id}_S`);
  const endAt = stream.indexOf(`${id}_E`, startAt < 0 ? 0 : startAt);
  if (endAt < 0) return undefined;

  // With the start marker gone, the retained buffer opens partway through the
  // command's own output, so that is where the body begins.
  const afterStart = startAt < 0 ? 0 : stream.indexOf("\n", startAt) + 1;
  const body =
    startAt >= 0 && (afterStart === 0 || afterStart > endAt) ? "" : stream.slice(afterStart, endAt);
  const statusLine = stream.slice(endAt).split("\n", 1)[0] ?? "";
  const parsed = Number.parseInt(statusLine.slice(`${id}_E`.length).trim(), 10);

  // The end marker is printed on its own line, so the body ends with the
  // newline that preceded it; trailing CR comes from the pty, not the command.
  const cleaned = withoutForeignFraming(body.replace(/\r?\n?$/, "").replaceAll("\r\n", "\n"), id);

  return {
    exitStatus: Number.isFinite(parsed) ? parsed : null,
    foreignOutputSuspected: cleaned.foreignOutputSuspected,
    output: cleaned.text,
    outputComplete: startAt >= 0,
  };
}

/** Keep a timed-out pane reserved until its wrapper ends or its pane dies. */
async function waitForSettlement(
  context: ToolContext,
  pane: Pane,
  id: string,
  cursor: string | undefined,
  initialTail: Awaited<ReturnType<ToolContext["hub"]["tail"]>>,
): Promise<void> {
  let tail = initialTail;
  let askedAlive = 0;
  for (;;) {
    if (context.hub.closed) return;
    if (tail?.endReason !== undefined) {
      if (tail.endReason === "hub_closed") return;
      tail = undefined;
    }

    let stream: string;
    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- each capture follows the previous observation.
      stream = (await pane.capture({ start: -FALLBACK_SCROLLBACK }).catch(() => [])).join("\n");
    } else {
      stream = tail.read(cursor).text;
    }
    if (slice(stream, id) !== undefined) return;

    if (Date.now() - askedAlive >= SETTLEMENT_LIVENESS_MS) {
      askedAlive = Date.now();
      // eslint-disable-next-line no-await-in-loop -- liveness is sampled over time.
      const current = await context
        .snapshot()
        .then((snapshot) => snapshot.panes.first({ id: pane.id }))
        .catch(() => undefined);
      if (current === undefined || current.dead === true) return;
    }

    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- a streamless monitor polls serially.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SETTLEMENT_POLL_MS);
        timer.unref?.();
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- each wait follows the previous read.
    const changed = await tail.changed(SETTLEMENT_POLL_MS);
    if (changed === "closed" && tail.endReason === "hub_closed") return;
  }
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
  const sessionId = pane.format.session_id;

  let tail = context.policy.liveEnabled ? await context.hub.tail(sessionId, pane.id) : undefined;

  // Read the stream position before sending: output printed between the send
  // and the first read would otherwise be attributed to whatever came before.
  const cursor = tail?.cursor;
  await pane.sendKeys(payload, { literal: true });

  const deadline = Date.now() + budget;
  let missedBytes = 0;
  let usedFallback = tail === undefined;
  while (Date.now() < deadline && signal?.aborted !== true) {
    if (tail?.endReason !== undefined) {
      tail = undefined;
      usedFallback = true;
    }
    let stream: string;
    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- each read follows the last.
      stream = (await pane.capture({ start: -FALLBACK_SCROLLBACK }).catch(() => [])).join("\n");
    } else {
      const reading = tail.read(cursor);
      stream = reading.text;
      missedBytes = Math.max(missedBytes, reading.missedBytes);
    }
    const found = slice(stream, id);
    if (found !== undefined) {
      return {
        effectiveTimeoutMs: budget,
        missedBytes,
        ...found,
        outcome: "completed",
        outputComplete: found.outputComplete && !usedFallback,
        settled: Promise.resolve(),
      };
    }
    if (tail === undefined) {
      // eslint-disable-next-line no-await-in-loop -- the poll follows its read.
      await new Promise((resolve) => setTimeout(resolve, FALLBACK_POLL_MS));
    } else {
      // eslint-disable-next-line no-await-in-loop -- the wait follows its read.
      const change = await tail.changed(
        Math.min(FALLBACK_POLL_MS * 4, Math.max(1, deadline - Date.now())),
        signal,
      );
      if (change === "closed") {
        tail = undefined;
        usedFallback = true;
      }
    }
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

  // Present is not alive: a pane kept by remain-on-exit still exists, and
  // reporting timed_out for it says the command may yet finish.
  const after = (await context.snapshot()).panes.first({ id: pane.id });
  const alive = after !== undefined && after.dead !== true;
  return {
    effectiveTimeoutMs: budget,
    exitStatus: null,
    foreignOutputSuspected: cleaned.foreignOutputSuspected,
    missedBytes,
    outcome: alive ? "timed_out" : "pane_died",
    output: cleaned.text,
    outputComplete: startAt >= 0 && missedBytes === 0 && !usedFallback,
    settled: alive ? waitForSettlement(context, pane, id, cursor, tail) : Promise.resolve(),
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
