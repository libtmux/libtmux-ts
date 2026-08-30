import { adaptRawResult, prepareCommandRequest } from "./request.js";
import { runCommand, runCommandBytes } from "./command.js";
import { TmuxTransportError } from "../../exc.js";
import type { RuntimeContext } from "../runtime/context.js";

/**
 * Ask tmux whether a session exists.
 *
 * `has-session` reports absence with a nonzero exit rather than empty output,
 * so this deliberately bypasses the raising runner: "no such session" is an
 * answer, not a failure.
 */
export async function hasSession(runtime: RuntimeContext, name: string): Promise<boolean> {
  const result = adaptRawResult(
    await runtime.transport.execute(
      prepareCommandRequest(
        runtime.connection,
        ["has-session", "-t", `=${name}`],
        runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs },
      ),
    ),
  );
  return result.returncode === 0;
}

/** Run a tmux config file against the server. */
export async function sourceFile(runtime: RuntimeContext, path: string): Promise<void> {
  await runCommand(runtime, ["source-file", path]);
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
  await runCommand(runtime, ["set-buffer", "-b", name, data]);
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
  options: { readonly append?: boolean } = {},
): Promise<void> {
  await runCommand(runtime, [
    "save-buffer",
    ...(options.append === true ? ["-a"] : []),
    "-b",
    name,
    path,
  ]);
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
    return result.returncode === 0;
  } catch (error) {
    if (
      error instanceof TmuxTransportError &&
      error.kind !== "cancelled" &&
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
export async function raiseIfDead(runtime: RuntimeContext): Promise<void> {
  await runCommand(runtime, ["list-sessions"]);
}
