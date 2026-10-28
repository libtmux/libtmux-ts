/**
 * Programs that outlive one call: this server ends each at its lifetime, and
 * the library's lease has tmux do it should this server die.
 */

import { randomUUID } from "node:crypto";

import {
  ServerNotLocalError,
  StreamLimitError,
  VersionTooLowError,
  type Program,
  type ProgramExit,
} from "libtmux";
import { z } from "zod";

import type { ToolContext } from "../context.js";
import { DEFAULT_BLOCKING_WAIT_MS, effectiveWaitMs, MAX_RESULT_BYTES } from "../policy.js";
import { type ToolRegistrar } from "../register.js";
import { fail, ok } from "../results.js";
import { inlineRequestText, paneIdSchema } from "../schemas.js";
import { isFailure } from "../target_resolution.js";
import { TextFilter } from "../text.js";
import { besidePane, programArgv } from "./input.js";

/** How long a started program runs unless told otherwise, and at most. */
const DEFAULT_LIFETIME_MS = 600_000;
const MAX_LIFETIME_MS = 3_600_000;
const MAX_LIVE_PROGRAMS = 16;
/** Ended programs whose text stays readable; the oldest is forgotten first. */
const MAX_ENDED_PROGRAMS = 16;
/** How soon tmux ends a program after this server stops renewing its lease. */
const ORPHAN_AFTER_MS = 30_000;
/** Each program's copy and readable text stop here; the program runs on. */
const MAX_COPY_BYTES = 4 * 1024 * 1024;

type EndedBy = "exited" | "gone" | "lifetime" | "stopped";

interface Entry {
  readonly program: Program;
  /** The readable text so far, as UTF-8, in arrival order. */
  readonly chunks: Buffer[];
  size: number;
  /** Why the text lacks part of the output: the copy hit its cap, or the end was lost. */
  missing: "cut" | "lost" | "stopped" | undefined;
  /** Whether the copy has ended, so `chunks` and `missing` are final. */
  streamed: boolean;
  exit: ProgramExit | undefined;
  endedBy: EndedBy | undefined;
  /** When it ended, which orders the ended programs kept readable. */
  endedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly wakers: Set<() => void>;
}

function wake(entry: Entry): void {
  for (const waker of entry.wakers) waker();
}

/** Resolve when the entry changes, `ms` pass, or `signal` aborts. */
async function changed(entry: Entry, ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      entry.wakers.delete(done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    entry.wakers.add(done);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** Bytes `[start, end)` of text held as chunks. */
function slice(chunks: readonly Buffer[], start: number, end: number): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const next = offset + chunk.length;
    if (next > start && offset < end) {
      parts.push(chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset)));
    }
    offset = next;
  }
  return Buffer.concat(parts);
}

/** Copy the program's output in as it is written, then record how it ended. */
async function pump(entry: Entry): Promise<void> {
  const filter = new TextFilter();
  try {
    for await (const chunk of entry.program.stream()) {
      const text = Buffer.from(filter.push(chunk), "utf8");
      entry.chunks.push(text);
      entry.size += text.length;
      wake(entry);
    }
  } catch (error) {
    if (error instanceof StreamLimitError) entry.missing = "cut";
    // A stop or the lifetime ends the copy with the program, so its last output may be unread.
    else if (entry.endedBy !== undefined) entry.missing = "stopped";
    // tmux never read the end, or the pane was removed from outside before it was.
    else entry.missing = "lost";
  }
  entry.streamed = true;
  wake(entry);
  try {
    entry.exit = await entry.program.wait();
    entry.endedBy ??= "exited";
  } catch {
    // Killed by this server, or its pane removed from outside: no status to report.
    entry.endedBy ??= "gone";
  }
  entry.endedAt ||= performance.now();
  clearTimeout(entry.timer);
  wake(entry);
  // Its text is held here, so the pane, its lease and its copy can go now.
  await entry.program.kill().catch(() => undefined);
}

/** The text a reader sees, ending on a whole character: a cut never splits one. */
export function readable(
  chunks: readonly Buffer[],
  size: number,
  start: number,
  limit: number = MAX_RESULT_BYTES,
): { readonly end: number; readonly text: string } {
  let end = Math.min(size, start + limit);
  // Step back while the byte the cut would start the next read on continues a character.
  while (end > start && end < size && ((slice(chunks, end, end + 1)[0] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { end, text: slice(chunks, start, end).toString("utf8") };
}

/** Ends every live started program; the server calls it as it closes. */
export interface StartedPrograms {
  close(): Promise<void>;
}

export function registerPrograms(mcp: ToolRegistrar, context: ToolContext): StartedPrograms {
  const entries = new Map<string, Entry>();
  /** Starts past the capacity check whose program is not in `entries` yet. */
  let starting = 0;
  let closing = false;
  const inFlight = new Set<Promise<unknown>>();
  const live = (): number =>
    [...entries.values()].filter((entry) => entry.endedBy === undefined).length + starting;

  /** Forget the oldest ended programs past the ones kept readable. */
  function trim(): void {
    const ended = [...entries]
      .filter(([, entry]) => entry.endedBy !== undefined)
      .toSorted(([, left], [, right]) => left.endedAt - right.endedAt);
    for (const [id, entry] of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_PROGRAMS))) {
      entries.delete(id);
      clearTimeout(entry.timer);
    }
  }

  /** End the program and remove its pane; a stop also forgets the id, a lifetime keeps it readable. */
  async function end(id: string, entry: Entry, by: EndedBy): Promise<void> {
    if (by === "stopped") entries.delete(id);
    clearTimeout(entry.timer);
    entry.endedAt ||= performance.now();
    entry.endedBy ??= by;
    wake(entry);
    await entry.program.kill().catch(() => undefined);
  }

  mcp.registerTool(
    "start_program",
    {
      description:
        "Start a program in a pane of its own and return at once with a programId. Use it " +
        "for a program that runs longer than one wait, such as a build or a server, or one " +
        "that needs keys between reads; run_program is the one-call form. read_program " +
        "reads its output as it is written and reports its exit; send_keys reaches its " +
        "paneId; stop_program ends it. This server ends it and removes its pane when " +
        "lifetimeMs runs out, even if no later call arrives, and tmux does if this server dies. " +
        "No shell parses argv, and PAGER and GIT_PAGER are cat. It takes no input, keep, " +
        "inheritShell or separateStderr: for those, use run_program. Requires tmux 3.8 or newer.",
      inputSchema: {
        argv: programArgv,
        fromPaneId: paneIdSchema
          .optional()
          .describe("Run beside this pane, in its directory and session, as run_program does."),
        height: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Rows of the program's terminal. Defaults to tmux's default-size."),
        placement: z
          .enum(["window", "split"])
          .optional()
          .describe(
            'With fromPaneId: "window", the default, or "split" beside the pane, where a ' +
              "person watching it sees the program. Focus stays put.",
          ),
        startDirectory: inlineRequestText("startDirectory")
          .optional()
          .describe(
            "Directory the program starts in, taken literally; one that cannot be entered " +
              "ends it with exit status 126.",
          ),
        lifetimeMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How long the program may run: it is ended and its pane removed this long after the " +
              `start. ${String(DEFAULT_LIFETIME_MS / 60_000)} minutes by default; longer than ` +
              `${String(MAX_LIFETIME_MS / 60_000)} is cut to that.`,
          ),
        width: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Columns of the program's terminal."),
      },
      outputSchema: {
        effectiveLifetimeMs: z.number().int().describe("The lifetime enforced."),
        paneId: paneIdSchema.describe("The program's pane, for send_keys or capture_pane."),
        programId: z.string().describe("Pass to read_program and stop_program."),
      },
      title: "Start a program",
    },
    async (
      { argv, fromPaneId, height, lifetimeMs: asked, placement, startDirectory, width },
      extra,
    ) => {
      if (closing) return fail({ reason: "This server is closing; no program was started." });
      if (live() >= MAX_LIVE_PROGRAMS) {
        return fail({
          hint: "stop_program ends one you no longer need.",
          reason: `${String(MAX_LIVE_PROGRAMS)} started programs are already running.`,
        });
      }
      // Held from the check to the map, so concurrent starts cannot pass the cap together.
      starting += 1;
      let program: Program;
      const lifetimeMs = Math.min(asked ?? DEFAULT_LIFETIME_MS, MAX_LIFETIME_MS);
      try {
        const from = await besidePane(context, { fromPaneId, height, placement, width });
        if (isFailure(from)) return from;
        const spawning = context.tmux.spawn(argv, {
          // A pager waits for keys nobody will press.
          environment: { GIT_PAGER: "cat", PAGER: "cat" },
          ...(from === undefined ? {} : { from }),
          ...(height === undefined ? {} : { height }),
          maxStreamBytes: MAX_COPY_BYTES,
          orphanAfterMs: ORPHAN_AFTER_MS,
          ...(placement === undefined ? {} : { placement }),
          // A cancelled request stops setup; once started, the lifetime ends the program.
          signal: extra.signal,
          ...(startDirectory === undefined ? {} : { startDirectory }),
          stream: true,
          ...(width === undefined ? {} : { width }),
        });
        inFlight.add(spawning);
        try {
          program = await spawning;
        } finally {
          inFlight.delete(spawning);
        }
        // A close that began while this start resolved its pane has already swept.
        if (closing) {
          await program.kill().catch(() => undefined);
          return fail({ reason: "This server is closing; the program was ended." });
        }
      } catch (error) {
        if (error instanceof ServerNotLocalError) {
          return fail({
            hint: "Run it with run_program, which needs no copy, or from a server on this machine.",
            reason: error.message,
          });
        }
        if (!(error instanceof VersionTooLowError)) throw error;
        return fail({
          hint: "On this server, run the command with run_shell_command in an existing shell pane.",
          reason: error.message,
        });
      } finally {
        starting -= 1;
      }
      const id = `program-${randomUUID().slice(0, 8)}`;
      const entry: Entry = {
        chunks: [],
        endedAt: 0,
        endedBy: undefined,
        missing: undefined,
        streamed: false,
        exit: undefined,
        program,
        size: 0,
        timer: undefined,
        wakers: new Set(),
      };
      entry.timer = setTimeout(() => void end(id, entry, "lifetime"), lifetimeMs);
      entry.timer.unref();
      entries.set(id, entry);
      void pump(entry).then(trim);
      return ok(
        { effectiveLifetimeMs: lifetimeMs, paneId: program.pane.id, programId: id },
        `[started ${id} in ${program.pane.id}; it is ended after ${String(lifetimeMs)}ms]`,
      );
    },
  );

  mcp.registerTool(
    "read_program",
    {
      description:
        "Read what a started program printed after cursor, waiting up to timeoutMs for new " +
        "output or its end, and report whether it has ended and how. Omit cursor on the " +
        "first read and pass back the one returned; a read that times out returns no text, " +
        "and the next read with the same cursor carries on. The text is the byte stream " +
        "with escape sequences removed, in write order; capture_pane on its paneId shows " +
        "the screen while it runs. Output stays readable after the end until stop_program, " +
        "or until enough programs have ended after it.",
      inputSchema: {
        cursor: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("The cursor the previous read_program returned. Omit to read from the start."),
        programId: z.string().min(1).max(64).describe("The id start_program returned."),
        timeoutMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "How long to wait for something new: 0 returns at once, and omitted is " +
              `${String(DEFAULT_BLOCKING_WAIT_MS / 1000)} seconds. Clamped by the server ceiling.`,
          ),
      },
      outputSchema: {
        cursor: z.number().int().describe("Pass to the next read_program."),
        effectiveTimeoutMs: z.number().int().describe("The wait allowed."),
        ended: z
          .boolean()
          .describe("Whether it has ended and every byte it wrote has been returned."),
        exitStatus: z
          .number()
          .int()
          .nullable()
          .describe(
            "The status as $? reports it once it completed on its own, otherwise null; " +
              "above 128 it is either a signal's 128 plus its number or the program's own exit.",
          ),
        lostEnd: z
          .boolean()
          .describe("True when tmux closed the pane before reading the end of the output."),
        outcome: z
          .enum(["running", "completed", "expired", "stopped", "gone"])
          .describe(
            "running: call again with cursor. completed: it ended on its own, as exitStatus " +
              "or signal says. expired: its lifetime ended it; start it again with a longer " +
              "lifetimeMs. stopped: stop_program ended it while this read waited. gone: its " +
              "pane was removed from outside, with no status.",
          ),
        outputComplete: z
          .boolean()
          .describe(
            "False when outputCut or lostEnd is true, or when a stop or the lifetime ended " +
              "the program before its output was read to the end.",
          ),
        outputCut: z
          .boolean()
          .describe("True once the copy stopped at its limit; later output is not kept."),
        signal: z
          .string()
          .nullable()
          .describe(
            'The signal that ended the program and its sh, such as "SIGKILL"; otherwise null. ' +
              "A program a signal ended alone reports 128 plus its number in exitStatus.",
          ),
        text: z.string().describe("What it printed after cursor."),
      },
      title: "Read a started program",
    },
    async ({ cursor, programId, timeoutMs }, extra) => {
      const entry = entries.get(programId);
      if (entry === undefined) {
        return fail({
          hint:
            "start_program starts one. stop_program forgets an id, and an ended program is " +
            "forgotten once enough newer ones end; its last read reported how it ended.",
          reason: `No started program ${programId}.`,
        });
      }
      const effectiveTimeoutMs = effectiveWaitMs(context.policy, timeoutMs);
      const after = cursor ?? 0;
      const deadline = Date.now() + effectiveTimeoutMs;
      // A stop marks the end at once; the copy it cuts ends a moment later.
      const settled = (): boolean => entry.streamed && entry.endedBy !== undefined;
      while (entry.size <= after && !settled() && !extra.signal.aborted) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        // eslint-disable-next-line no-await-in-loop -- each wait follows the last change.
        await changed(entry, left, extra.signal);
      }
      // A cursor past the text read so far stays put rather than starting over.
      const { end, text } = readable(entry.chunks, entry.size, Math.min(after, entry.size));
      // Ended only once every byte has been handed over.
      const finished = settled() && end === entry.size;
      // How it ended decides first: a stop's SIGTERM can also leave an exit status behind.
      const stopped = entry.endedBy === "stopped" || entry.endedBy === "lifetime";
      const exit = finished && !stopped ? entry.exit : undefined;
      let outcome: "completed" | "expired" | "gone" | "running" | "stopped" = "running";
      let headline = `running; cursor ${String(end)}`;
      if (finished && stopped) {
        outcome = entry.endedBy === "lifetime" ? "expired" : "stopped";
        headline = entry.endedBy === "lifetime" ? "ended at its lifetime" : "stopped";
      } else if (exit !== undefined) {
        outcome = "completed";
        headline =
          exit.signalCode === null
            ? `exit ${String(exit.exitCode)}`
            : `ended by ${exit.signalCode}`;
      } else if (finished) {
        outcome = "gone";
        headline = "its pane is gone, with no exit status";
      }
      let note = "";
      if (entry.missing === "cut") note = "\n[output past the copy limit is not kept]";
      if (entry.missing === "lost") note = "\n[tmux closed the pane before reading the end]";
      if (entry.missing === "stopped") note = "\n[output written as it was ended may be missing]";
      return ok(
        {
          cursor: end,
          effectiveTimeoutMs,
          ended: finished,
          exitStatus: exit?.exitCode ?? null,
          lostEnd: entry.missing === "lost",
          outcome,
          outputComplete: entry.missing === undefined,
          outputCut: entry.missing === "cut",
          signal: exit?.signalCode ?? null,
          text,
        },
        `${text}\n\n[${headline}]${note}`,
      );
    },
  );

  mcp.registerTool(
    "stop_program",
    {
      description:
        "End a started program and remove its pane now: SIGTERM, then SIGKILL two seconds " +
        "later. Its id is forgotten, so read what you need with read_program first.",
      inputSchema: {
        programId: z.string().min(1).max(64).describe("The id start_program returned."),
      },
      outputSchema: {
        programId: z.string().describe("The program that was ended."),
      },
      title: "Stop a started program",
    },
    async ({ programId }) => {
      const entry = entries.get(programId);
      if (entry === undefined) {
        return fail({
          hint: "A stop forgets the id; read_program reads one its lifetime ended.",
          reason: `No started program ${programId}.`,
        });
      }
      await end(programId, entry, "stopped");
      return ok({ programId }, `[stopped ${programId}; its pane is removed]`);
    },
  );

  return {
    async close() {
      closing = true;
      await Promise.allSettled(inFlight);
      await Promise.all([...entries].map(([id, entry]) => end(id, entry, "stopped")));
    },
  };
}
