import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { adaptRawResult, prepareCommandRequest } from "./request.js";
import { isColdEndpoint, runCommand, runCommandBytes } from "./command.js";
import { literalFormat } from "./options.js";
import { TmuxCommandError, TmuxTransportError } from "../../errors.js";
import type { SaveBufferOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";

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
 * Make the file tmux is about to write, readable by its owner alone.
 *
 * tmux creates a missing file with the umask of the process that opens it,
 * usually 0644, and keeps the mode of one that exists, so creating it first is
 * the only way to keep a pane's text from other users. Resolves to the path made,
 * or `undefined` when nothing was: `-` is tmux's stdout, a file that exists
 * keeps its mode, and one that cannot be made is left for tmux to report. A
 * relative path and a leading `~/` are resolved as tmux resolves them.
 */
async function createPrivateFile(path: string): Promise<string | undefined> {
  if (path === "-") return undefined;
  const target = path.startsWith("~/")
    ? `${homedir()}${path.slice(1)}`
    : isAbsolute(path)
      ? path
      : `${process.cwd()}/${path}`;
  try {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.close();
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Write a paste buffer to a file, rather than returning it as text.
 *
 * `showBuffer` brings the contents back through this process, which for a
 * large buffer means holding it in memory and, for an agent, spending its
 * context on bytes it only wants stored. tmux writes the file itself, so
 * neither happens. The path is resolved by the tmux server, so it is on the
 * machine tmux runs on rather than this one.
 *
 * The file is created here, with mode 0600, just before tmux writes it, because
 * tmux has no flag for a mode. `#` in the path is literal.
 */
export async function saveBuffer(
  runtime: RuntimeContext,
  name: string,
  path: string,
  options: SaveBufferOptions = {},
): Promise<void> {
  const created = await createPrivateFile(path);
  try {
    await runCommand(
      runtime,
      // `--` keeps a path starting with `-` from being read as one of
      // save-buffer's own flags.
      [
        "save-buffer",
        ...(options.append === true ? ["-a"] : []),
        "-b",
        name,
        "--",
        literalFormat(path),
      ],
      options,
    );
  } catch (error) {
    // tmux refusing the save means it wrote nothing. After a timeout or a
    // cancellation it may still write, and an empty file only its owner can
    // read is the safe thing to leave.
    if (created !== undefined && error instanceof TmuxCommandError) {
      await rm(created, { force: true }).catch(() => undefined);
    }
    throw error;
  }
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
