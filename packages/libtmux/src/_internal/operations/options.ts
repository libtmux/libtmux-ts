import type { CommandOptions } from "../../common.js";
import type { SetOptionOptions } from "../../types.js";
import type { OptionScope } from "../../constants.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommand } from "./command.js";

const SCOPE_FLAGS: Readonly<Record<OptionScope, readonly string[]>> = Object.freeze({
  pane: ["-p"],
  server: ["-s"],
  session: [],
  window: ["-w"],
});

/** What `vis(3)` writes for a byte that cannot be printed, and its byte. */
const CONTROL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["0", "\0"],
  ["a", "\u0007"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["s", " "],
  ["t", "\t"],
  ["v", "\v"],
]);

/**
 * Undo the `vis(3)` escaping inside a quoted or bare value.
 *
 * A backslash introduces a three-digit octal byte, one of the C-style letters
 * above, or a character standing for itself — which is how `\\`, `\"`, `\$`
 * and `\~` all arrive back as what they were.
 */
function unescapeValue(text: string): string {
  if (!text.includes("\\")) return text;
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") {
      result += text[index];
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      result += "\\";
      break;
    }
    const octal = /^[0-7]{3}/u.exec(text.slice(index + 1, index + 4));
    if (octal !== null) {
      result += String.fromCharCode(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    result += CONTROL_ESCAPES.get(next) ?? next;
    index += 1;
  }
  return result;
}

/**
 * Read the value tmux printed for an option or a hook back into what was set.
 *
 * `args_escape` wraps a value in double quotes when it holds any of `` #';${}%``,
 * in single quotes when it holds a `"` or a space and none of those, and writes
 * an empty value as `''`. Inside either, and bare, `vis(3)` escaping renders a
 * backslash — and within double quotes a `"` or a `$` — with a leading one.
 *
 * Reversed shallowly, a `status-left` or a hook comes back still carrying its
 * own escaping, and an empty option reads as two characters rather than none.
 * A value tmux did not need to quote passes through untouched.
 */
export function decodeOptionValue(raw: string): string {
  if (raw === "''") return "";
  const wrapped =
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
  return unescapeValue(wrapped ? raw.slice(1, -1) : raw);
}

/**
 * tmux prints one option per line as a name and an optional value, quoting the
 * value only when it needs to. Array-valued options arrive as repeated lines
 * carrying their index in the name, as in `command-alias[0]`, and are preserved
 * verbatim here so the index survives for a later sparse-array reader.
 */
export function parseNameValueLine(line: string): readonly [string, string] | undefined {
  if (line === "") return undefined;
  const separator = line.indexOf(" ");
  if (separator === -1) return [line, ""];
  return [line.slice(0, separator), decodeOptionValue(line.slice(separator + 1))];
}

/**
 * Read the options tmux reports for one scope.
 *
 * This is the scope's own view, not a resolved one. Window and pane scopes list
 * only what was set on them, so a freshly created pane reports nothing at all
 * rather than the values it would inherit. `global` reads the defaults every
 * session or window inherits, which is where most of tmux's options live and
 * where a per-object read finds nothing. Resolving inheritance needs tmux's
 * `-A`, which is a separate reader because it changes what a caller is asking.
 */
export async function showOptions(
  runtime: RuntimeContext,
  scope: OptionScope,
  target?: string | null,
  flags: { readonly global?: boolean } = {},
): Promise<ReadonlyMap<string, string>> {
  const lines = await runCommand(runtime, [
    "show-options",
    ...SCOPE_FLAGS[scope],
    ...(flags.global === true ? ["-g"] : []),
    ...(target == null ? [] : ["-t", target]),
  ]);

  const options = new Map<string, string>();
  for (const line of lines) {
    const parsed = parseNameValueLine(line);
    if (parsed !== undefined) options.set(parsed[0], parsed[1]);
  }
  return options;
}

/**
 * Read the option values that actually govern one object.
 *
 * `showOptions` answers what was set here, which for a fresh window or pane is
 * nothing at all — the values it runs under live in the tables it inherits.
 * This resolves the two, so `history-limit` and `default-shell` have an answer
 * on any object rather than only on whichever scope happens to hold them.
 *
 * tmux marks an inherited entry by suffixing the name with `*`, which is
 * stripped here: the name is the option's, and where it came from is answered
 * by whether `showOptions` also reports it.
 */
export async function showResolvedOptions(
  runtime: RuntimeContext,
  scope: OptionScope,
  target?: string | null,
): Promise<ReadonlyMap<string, string>> {
  const lines = await runCommand(runtime, [
    "show-options",
    "-A",
    ...SCOPE_FLAGS[scope],
    ...(target == null ? [] : ["-t", target]),
  ]);

  const options = new Map<string, string>();
  for (const line of lines) {
    const parsed = parseNameValueLine(line);
    if (parsed === undefined) continue;
    options.set(parsed[0].endsWith("*") ? parsed[0].slice(0, -1) : parsed[0], parsed[1]);
  }
  return options;
}

/** Set one option at a scope. `append` uses tmux's `-a` to extend a value. */
export async function setOption(
  runtime: RuntimeContext,
  scope: OptionScope,
  target: string | null | undefined,
  name: string,
  value: string,
  options: SetOptionOptions & { readonly global?: boolean } = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "set-option",
      ...SCOPE_FLAGS[scope],
      ...(options.global === true ? ["-g"] : []),
      ...(options.append === true ? ["-a"] : []),
      ...(target == null ? [] : ["-t", target]),
      name,
      value,
    ],
    options,
  );
}

/** Remove one option at a scope so it falls back to what it inherits. */
export async function unsetOption(
  runtime: RuntimeContext,
  scope: OptionScope,
  target: string | null | undefined,
  name: string,
  options: CommandOptions & { readonly global?: boolean } = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "set-option",
      ...SCOPE_FLAGS[scope],
      ...(options.global === true ? ["-g"] : []),
      "-u",
      ...(target == null ? [] : ["-t", target]),
      name,
    ],
    options,
  );
}
