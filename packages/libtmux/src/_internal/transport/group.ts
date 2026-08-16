import { randomUUID } from "node:crypto";

/**
 * Running several tmux commands as one command list, and why that is atomic.
 *
 * tmux gives every client its own command queue and `cmdq_next` drains it in a
 * loop that never returns to the event loop between items, so a list submitted
 * by one client cannot be interleaved with another client's commands. Four
 * separate `tmux list-…` processes are four clients and four queues; one
 * command list is one queue, drained whole.
 *
 * A command that fails removes the rest of its list, so a group answers with
 * the results of the commands tmux actually ran — never with a placeholder for
 * one it did not.
 */

/**
 * Drop the global flags that select a server.
 *
 * Only the first command of a list carries them: the rest are subcommands of
 * one invocation, and a repeated `-S` lexes as a command. Every tmux global
 * flag is a leading `-` argument and no subcommand starts with one, which is a
 * more durable rule than counting how many flags some caller happened to build.
 */
export function subcommandOf(args: readonly string[]): readonly string[] {
  const start = args.findIndex((argument) => !argument.startsWith("-"));
  return start === -1 ? [] : args.slice(start);
}

/**
 * A marker that separates one command's stdout from the next.
 *
 * Only the spawning transport needs it — control mode fences every command in
 * its own `%begin`/`%end`. It has to survive `display-message -p`, which
 * expands formats and rejects a leading `-`, so: no `#`, no leading dash, and
 * random enough that no listing can produce it.
 */
export function createGroupSeparator(): string {
  return `ltxgroup${randomUUID().replaceAll("-", "")}`;
}

/**
 * How much of one command a tmux client may hand the server.
 *
 * `client.c` packs the whole argv into a single imsg and refuses anything over
 * `MAX_IMSGSIZE`, which OpenBSD's imsg — and tmux's bundled copy — fix at 16KB.
 * It bounds the *spawning* transport only: control mode sends a command as text
 * on an established socket and never packs an argv.
 */
export const MAX_PACKED_ARGV_BYTES = 16384;

/** What tmux counts: every argument plus its terminating NUL. */
export function packedArgvBytes(argv: readonly string[]): number {
  let total = 0;
  for (const argument of argv) total += Buffer.byteLength(argument, "utf8") + 1;
  return total;
}

/**
 * The argv that runs `requests` as one command list, with output boundaries.
 *
 * Only the first request keeps its server-selecting flags; the rest contribute
 * subcommands. `display-message -p` between them prints the boundary that puts
 * each command's stdout back in its own section.
 */
export function assembleGroupArgv(
  requests: readonly { readonly args: readonly string[] }[],
  separator: string,
): readonly string[] {
  const [first, ...rest] = requests;
  if (first === undefined) return Object.freeze([]);
  const argv = [...first.args];
  for (const request of rest) {
    argv.push(";", "display-message", "-p", separator, ";", ...subcommandOf(request.args));
  }
  return Object.freeze(argv);
}

/**
 * Split a byte stream on a marker line, keeping the pieces between markers.
 *
 * Byte-wise rather than by decoding: a pane title can carry any byte sequence,
 * and decoding to split would corrupt what the caller then has to parse.
 */
function splitOnMarker(bytes: Uint8Array, marker: string): readonly Uint8Array[] {
  const needle = new TextEncoder().encode(marker);
  const sections: Uint8Array[] = [];
  let start = 0;
  for (;;) {
    const at = indexOfBytes(bytes, needle, start);
    if (at < 0) {
      sections.push(bytes.subarray(start));
      return sections;
    }
    sections.push(bytes.subarray(start, at));
    start = at + needle.length;
  }
}

function indexOfBytes(source: Uint8Array, needle: Uint8Array, fromIndex: number): number {
  const lastStart = source.length - needle.length;
  for (let index = fromIndex; index <= lastStart; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (source[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

/**
 * One tmux invocation that runs a whole group, and the way back out of it.
 *
 * Exported because an engine that runs tmux somewhere else — over ssh, in a
 * container, through a daemon — has to get this exactly right or its snapshots
 * tear, and the way to get it right is not to write it again. The built-in
 * spawning engine calls this, so what ships is what is under test.
 */
export function asSingleInvocation(requests: readonly { readonly args: readonly string[] }[]): {
  readonly args: readonly string[];
  sections(stdout: Uint8Array): readonly Uint8Array[];
} {
  const separator = createGroupSeparator();
  return {
    args: assembleGroupArgv(requests, separator),
    sections: (stdout) => splitOnMarker(stdout, `${separator}\n`),
  };
}
