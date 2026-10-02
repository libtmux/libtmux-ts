import { adaptRawResult, prepareCommandRequest } from "./request.js";
import { isColdEndpoint, runCommand, runCommandBytes } from "./command.js";
import { LibTmuxError, TmuxTransportError, WaitTimeoutError } from "../../errors.js";
import type { CommandOptions } from "../../common.js";
import type { ChannelWaitOptions, SaveBufferOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { timerDuration } from "../timing.js";

/**
 * Ask tmux whether a session exists.
 *
 * No `-t` target spelling is both exact and correct for every name: `=name`
 * matches exactly but tmux reads a "." or ":" in `name` as a target
 * separator first, so `=my.proj` fails even when a session is named exactly
 * that; `name:` survives those characters but resolves a unique prefix the
 * same way a bare name does, so `work:` would answer yes for `workspace`.
 * Listing every session and comparing the name in JavaScript is exact for
 * any name tmux can store. `list-sessions` fails against a socket with no
 * server running the same way `has-session` did, and that failure is
 * answered false, not raised: "no such session" is an answer, not a failure.
 * Any other failure — a socket this caller has no permission to reach, a
 * daemon that answered and refused the command — is raised, not folded into
 * "no such session".
 */
export async function hasSession(runtime: RuntimeContext, name: string): Promise<boolean> {
  try {
    const names = await runCommand(runtime, ["list-sessions", "-F", "#{session_name}"]);
    return names.includes(name);
  } catch (error) {
    if (isColdEndpoint(error)) return false;
    throw error;
  }
}

/** Run a tmux config file against the server. */
export async function sourceFile(runtime: RuntimeContext, path: string): Promise<void> {
  // `--` keeps a path starting with `-` from being read as one of
  // source-file's own flags.
  await runCommand(runtime, ["source-file", "--", path]);
}

/** Every command name the running tmux understands. */
export async function listCommands(runtime: RuntimeContext): Promise<readonly string[]> {
  return runCommand(runtime, ["list-commands", "-F", "#{command_list_name}"]);
}

/** Store a named paste buffer. */
export async function setBuffer(
  runtime: RuntimeContext,
  name: string,
  data: string,
): Promise<void> {
  // `--` keeps data starting with `-` from being read as one of set-buffer's
  // own flags; the buffer name reaches tmux through `-b`, which is safe
  // regardless of what it starts with.
  await runCommand(runtime, ["set-buffer", "-b", name, "--", data]);
}

/**
 * Fill a paste buffer from data fed through tmux's stdin.
 *
 * `setBuffer` passes its data as a command-line argument, which caps it at the
 * platform's argument limit and mangles anything that is not text. This reads
 * the same data from stdin instead, so a large or binary payload arrives whole.
 */
export async function loadBuffer(
  runtime: RuntimeContext,
  name: string,
  data: string | Uint8Array,
): Promise<void> {
  await runCommand(runtime, ["load-buffer", "-b", name, "-"], { stdin: data });
}

/** Read a named paste buffer's contents. */
export async function showBuffer(
  runtime: RuntimeContext,
  name: string,
): Promise<readonly string[]> {
  return runCommand(runtime, ["show-buffer", "-b", name]);
}

/** Read a named paste buffer without decoding or splitting its bytes. */
export async function showBufferBytes(runtime: RuntimeContext, name: string): Promise<Uint8Array> {
  return runCommandBytes(runtime, ["show-buffer", "-b", name]);
}

/** Every buffer name the server currently holds. */
export async function listBuffers(runtime: RuntimeContext): Promise<readonly string[]> {
  return runCommand(runtime, ["list-buffers", "-F", "#{buffer_name}"]);
}

/**
 * Write a paste buffer to a file, rather than returning it as text.
 *
 * `showBuffer` brings the contents back through this process, which for a
 * large buffer means holding it in memory and, for an agent, spending its
 * context on bytes it only wants stored. tmux writes the file itself, so
 * neither happens. The path is resolved by the tmux server, so it is on the
 * machine tmux runs on rather than this one.
 */
export async function saveBuffer(
  runtime: RuntimeContext,
  name: string,
  path: string,
  options: SaveBufferOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    // `--` keeps a path starting with `-` from being read as one of
    // save-buffer's own flags.
    ["save-buffer", ...(options.append === true ? ["-a"] : []), "-b", name, "--", path],
    options,
  );
}

/** Discard a named paste buffer. */
export async function deleteBuffer(runtime: RuntimeContext, name: string): Promise<void> {
  await runCommand(runtime, ["delete-buffer", "-b", name]);
}

/**
 * Whether the tmux server is reachable.
 *
 * A missing daemon, an absent socket, a permission error, and a missing tmux
 * binary all answer `false` rather than raising, because "is the server there?"
 * is a question with a negative answer, not a failure to ask it.
 */
export async function isAlive(runtime: RuntimeContext): Promise<boolean> {
  try {
    const result = adaptRawResult(
      await runtime.transport.execute(
        prepareCommandRequest(
          runtime.connection,
          ["list-sessions"],
          runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs },
        ),
      ),
    );
    return result.exitCode === 0;
  } catch (error) {
    if (
      error instanceof TmuxTransportError &&
      error.kind !== "cancelled" &&
      error.kind !== "contract" &&
      error.kind !== "timeout"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Assert the tmux server is reachable, raising with tmux's own reason if not.
 *
 * Acquisition raises on an unreachable server rather than reading as empty, so
 * this adds no distinction a read does not already make. What it adds is a
 * check with nothing to check: `isAlive` answers yes or no, this one answers
 * with tmux's reason.
 */
export async function checkAlive(runtime: RuntimeContext): Promise<void> {
  await runCommand(runtime, ["list-sessions"]);
}

const DEFAULT_CHANNEL_WAIT_MS = 30_000;

/** How long a released waiter has to return before its client is killed. */
const RELEASE_GRACE_MS = 2_000;

/** Wake every client waiting on a channel, or remember the signal for the next one. */
export async function signalChannel(
  runtime: RuntimeContext,
  channel: string,
  options: CommandOptions = {},
): Promise<void> {
  // `--` keeps a channel starting with `-` from being read as a flag.
  await runCommand(runtime, ["wait-for", "-S", "--", channel], options);
}

/**
 * Block until a channel is signalled, with a deadline this function owns.
 *
 * Killing a waiting client does not take it off tmux's queue on 3.2a through
 * master: it stays as a ghost waiter and swallows the next signal, so a wait
 * that gives up this way costs whoever waits next. This one signals the
 * channel when it gives up, which wakes its own live waiter and lets that
 * client exit normally, leaving nothing queued. The client is killed only when
 * the release does not bring it back.
 *
 * A signal wakes every waiter on the channel, so one waiter per channel is the
 * safe shape, and a signal that lands in the instant of the deadline is
 * indistinguishable from the release and counts as the timeout.
 */
export async function waitForChannel(
  runtime: RuntimeContext,
  channel: string,
  options: ChannelWaitOptions = {},
): Promise<void> {
  if (channel === "") throw new TypeError("channel must not be empty");
  const deadline =
    options.timeoutMs === null
      ? undefined
      : timerDuration("timeoutMs", options.timeoutMs ?? DEFAULT_CHANNEL_WAIT_MS);
  const caller = options.signal;
  if (caller?.aborted === true) {
    throw new TmuxTransportError("channel wait cancelled before it started", {
      delivery: "not_started",
      kind: "cancelled",
      ...(caller.reason === undefined ? {} : { cause: caller.reason }),
    });
  }

  const kill = new AbortController();
  let released: "cancelled" | "timeout" | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const release = (why: "cancelled" | "timeout"): void => {
    if (released !== undefined) return;
    released = why;
    graceTimer = setTimeout(() => kill.abort(), RELEASE_GRACE_MS);
    // A failed signal means the server is gone, which also ends the waiter.
    void signalChannel(runtime, channel).catch(() => undefined);
  };
  const timer = deadline === undefined ? undefined : setTimeout(() => release("timeout"), deadline);
  const onAbort = (): void => release("cancelled");
  caller?.addEventListener("abort", onAbort, { once: true });

  try {
    await runCommand(runtime, ["wait-for", "--", channel], {
      signal: kill.signal,
      timeoutMs: null,
    });
  } catch (error) {
    if (released === undefined) throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    caller?.removeEventListener("abort", onAbort);
  }

  if (released === "timeout") {
    throw new WaitTimeoutError(`channel ${channel} was not signalled before the deadline`);
  }
  if (released === "cancelled") {
    throw new TmuxTransportError("channel wait cancelled", {
      delivery: "indeterminate",
      kind: "cancelled",
      ...(caller?.reason === undefined ? {} : { cause: caller.reason }),
    });
  }
  // tmux ends a waiting client with status 0 when the server dies, which is
  // indistinguishable from a signal until the server is asked.
  if (!(await isAlive(runtime))) {
    throw new LibTmuxError(`the tmux server exited while waiting on channel ${channel}`);
  }
}
