import { randomUUID } from "node:crypto";

import { ObjectNotFoundError, PaneRunTimeoutError, WaitTimeoutError } from "../../errors.js";
import type { PaneRunOptions, PaneRunResult } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { timerDuration } from "../timing.js";
import { runCommand } from "./command.js";
import { capturePane, sendKeys } from "./pane_io.js";
import { signalChannel, waitForChannel } from "./server_utils.js";

/**
 * How long the pane's shell has to acknowledge the typed line.
 *
 * A pane busy with another program, or a shell that cannot reach this tmux
 * server, never acknowledges, and without this bound the call would spend its
 * whole deadline waiting on a line nothing is running.
 */
const START_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_MS = 120_000;
const BEGIN = "LTRUN_B_";
const END = "LTRUN_E_";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell line that runs `command` and reports back.
 *
 * It signals a `started` channel, prints a begin marker, runs the command
 * through `eval` on a single-quoted string, stores `$?` in a pane user
 * option, prints an end marker and signals the `done` channel. The command
 * goes through `eval` so the typed line is always well formed: a syntax error
 * or an unterminated quote is the shell's error and a nonzero status, not a
 * half-typed line that leaves the wait blocked. `trap : INT` keeps the line
 * alive when the command is interrupted, which reads as status 130. The
 * leading space keeps the line out of history where the shell is set to, and
 * bash deletes its own entry besides.
 *
 * The markers are assembled by `printf` from two words, so the echoed line
 * never contains one: only the shell's output does.
 */
function buildLine(parts: {
  readonly command: string;
  readonly done: string;
  readonly option: string;
  readonly paneId: string;
  readonly started: string;
  readonly tmux: string;
  readonly token: string;
}): string {
  const { command, done, option, paneId, started, tmux, token } = parts;
  return (
    ` printf '%s%s\\n' ${BEGIN} ${token}; ${tmux} wait-for -S ${started}; ` +
    `_lt_c=${shellQuote(command)}; trap : INT; ` +
    'if [ -n "$ZSH_VERSION" ]; then eval "$_lt_c"; ' +
    'else command eval "$_lt_c"; fi; ' +
    `${tmux} set-option -p -t ${paneId} ${option} "$?"; trap - INT; ` +
    `unset _lt_c; printf '%s%s\\n' ${END} ${token}; ` +
    '[ -n "$BASH_VERSION" ] && history -d $HISTCMD 2>/dev/null; ' +
    `${tmux} wait-for -S ${done}`
  );
}

/**
 * What the pane drew for one run, read from a capture of the pane.
 *
 * Lines are matched by suffix, never by substring, so the echoed command
 * cannot match. The suffix match keeps output that has no
 * trailing newline. Trailing blanks are dropped from every line: tmux 3.2a
 * pads joined lines to the pane width, later versions do not.
 */
function extractRun(
  captured: readonly string[],
  token: string,
): { readonly ended: boolean; readonly output: readonly string[]; readonly truncated: boolean } {
  const lines = captured.map((line) => line.trimEnd());
  const begin = `${BEGIN}${token}`;
  const end = `${END}${token}`;
  // By suffix, like the end marker: a run typed while the shell was still
  // finishing an interrupted one is echoed early, so its marker prints after
  // the prompt on the same line.
  const start = lines.findLastIndex((line) => line.endsWith(begin));
  const body = start === -1 ? lines : lines.slice(start + 1);
  const truncated = start === -1;
  for (const [index, line] of body.entries()) {
    if (!line.endsWith(end)) continue;
    const head = line.slice(0, -end.length);
    return {
      ended: true,
      output: [...body.slice(0, index), ...(head === "" ? [] : [head])],
      truncated,
    };
  }
  let last = body.length;
  while (last > 0 && body[last - 1] === "") last -= 1;
  return { ended: false, output: body.slice(0, last), truncated };
}

/** Run a shell command in a pane and report its exit status and output. */
export async function runInPane(
  runtime: RuntimeContext,
  paneId: string,
  command: string,
  options: PaneRunOptions = {},
): Promise<PaneRunResult> {
  const limit = timerDuration("timeoutMs", options.timeoutMs ?? DEFAULT_RUN_MS);
  const token = randomUUID().replaceAll("-", "").slice(0, 16);
  const started = `libtmux-run-${token}-started`;
  const done = `libtmux-run-${token}`;
  const option = `@libtmux_run_${token}`;
  const deadline = performance.now() + limit;

  const { executable, socketName, socketPath } = runtime.connection;
  const tmux = [
    executable,
    ...(socketName === undefined ? [] : [`-L${socketName}`]),
    ...(socketPath === undefined ? [] : [`-S${socketPath}`]),
  ]
    .map(shellQuote)
    .join(" ");

  await sendKeys(
    runtime,
    paneId,
    buildLine({ command, done, option, paneId, started, tmux, token }),
    { literal: true, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );

  let failure: WaitTimeoutError | undefined;
  let didStart = true;
  const waitOptions = (
    timeoutMs: number,
  ): { signal?: typeof options.signal; timeoutMs: number } => ({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs,
  });
  try {
    await waitForChannel(runtime, started, waitOptions(START_TIMEOUT_MS));
    try {
      await waitForChannel(
        runtime,
        done,
        waitOptions(Math.max(Math.ceil(deadline - performance.now()), 1)),
      );
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      failure = error;
    }
  } catch (error) {
    if (!(error instanceof WaitTimeoutError)) throw error;
    failure = error;
    didStart = false;
  }
  // The shell that never started has nothing to signal, and one that timed out
  // still might: either way the channels are released so the next run on this
  // pane starts clean.
  if (failure !== undefined) {
    await signalChannel(runtime, started).catch(() => undefined);
    await signalChannel(runtime, done).catch(() => undefined);
  }

  let status: readonly string[];
  let captured: readonly string[];
  try {
    status = await runCommand(runtime, ["show-options", "-p", "-q", "-v", "-t", paneId, option]);
    captured = await capturePane(runtime, paneId, { joinWrapped: true, start: -1_000_000 });
  } finally {
    await runCommand(runtime, ["set-option", "-p", "-u", "-t", paneId, option]).catch(
      () => undefined,
    );
  }

  const { ended, output, truncated } = extractRun(captured, token);
  if (status[0] === undefined || status[0] === "" || !ended) {
    const alive = (await runCommand(runtime, ["list-panes", "-a", "-F", "#{pane_id}"])).includes(
      paneId,
    );
    if (!alive) throw new ObjectNotFoundError({ message: `Pane ${paneId} closed during run` });
    if (failure !== undefined) {
      throw new PaneRunTimeoutError(
        didStart
          ? `${JSON.stringify(command)} was still running after ${String(limit)} ms`
          : `the shell in pane ${paneId} did not acknowledge ${JSON.stringify(command)}; it is not at a Bourne-style shell prompt, or it cannot reach this tmux server`,
        { command, started: didStart, stdout: output },
      );
    }
    throw new ObjectNotFoundError({ message: `Pane ${paneId} closed during run` });
  }
  return Object.freeze({
    args: command,
    exitCode: Number(status[0]),
    stdout: Object.freeze([...output]),
    truncated,
  });
}
