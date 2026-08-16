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
  readonly outcome: "completed" | "pane_died" | "timed_out";
  readonly output: string;
}

/** How far back a fallback capture reads, so a marker that scrolled is still found. */
const FALLBACK_SCROLLBACK = 400;

/** How often the fallback re-reads the pane when no stream is available. */
const FALLBACK_POLL_MS = 60;

function frame(command: string, id: string, suppressHistory: boolean): string {
  const multiline = command.includes("\n") || command.includes("\r");
  const prefix = suppressHistory && !multiline ? " " : "";
  const open = `${prefix}m=${id}; printf '%s\\n' "\${m}_S"; (`;
  const close = `); s=$?; printf '%s %s\\n' "\${m}_E" "$s"`;
  return multiline
    ? `${open}\n${command.replace(/\s+$/, "")}\n${close}`
    : `${open} ${command} ${close}`;
}

/** Pull the command's own output out of the framed stream. */
function slice(
  stream: string,
  id: string,
): { exitStatus: number | null; output: string } | undefined {
  const startAt = stream.indexOf(`${id}_S`);
  if (startAt < 0) return undefined;
  const endAt = stream.indexOf(`${id}_E`, startAt);
  if (endAt < 0) return undefined;

  const afterStart = stream.indexOf("\n", startAt);
  const body = afterStart < 0 || afterStart > endAt ? "" : stream.slice(afterStart + 1, endAt);
  const statusLine = stream.slice(endAt).split("\n", 1)[0] ?? "";
  const parsed = Number.parseInt(statusLine.slice(`${id}_E`.length).trim(), 10);

  return {
    exitStatus: Number.isFinite(parsed) ? parsed : null,
    // The end marker is printed on its own line, so the body ends with the
    // newline that preceded it; trailing CR comes from the pty, not the command.
    output: body.replace(/\r?\n?$/, "").replaceAll("\r\n", "\n"),
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

  const alive = (await context.snapshot()).panes.exists({ id: pane.id });
  return {
    effectiveTimeoutMs: budget,
    exitStatus: null,
    outcome: alive ? "timed_out" : "pane_died",
    output: output.replaceAll("\r\n", "\n"),
  };
}

/**
 * A short id, unique enough that two concurrent runs cannot read each other's.
 *
 * Letters and digits only: the id is pasted into a shell word, so anything a
 * shell would treat as syntax cannot appear in it.
 */
function randomId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}
