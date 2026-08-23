import type { HookScope } from "../../types.js";
import { parseNameValueLine } from "./options.js";
import { runCommand } from "./command.js";
import type { RuntimeContext } from "../runtime/context.js";

function scopeArguments(scope: HookScope, target: string | null | undefined): readonly string[] {
  if (scope === "server") return ["-g"];
  return target == null ? [] : ["-t", target];
}

/** `after-new-window[1]`, which is how tmux names one element of a hook. */
const INDEXED_HOOK = /^(?<name>.+)\[(?<index>\d+)\]$/u;

/**
 * Every hook tmux reports at one scope, keyed by the name a caller sets.
 *
 * tmux stores each hook as an array and prints one line per element, naming it
 * `after-new-window[0]`. Keyed by that, nothing composes: `setHook` and
 * `unsetHook` both take the bare name, so a hook that was just set could not be
 * read back under the name it was set with.
 *
 * The commands come back in tmux's index order, and a hook carrying none is
 * absent rather than present and empty.
 */
export async function showHooks(
  runtime: RuntimeContext,
  scope: HookScope,
  target?: string | null,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const lines = await runCommand(runtime, ["show-hooks", ...scopeArguments(scope, target)]);
  const indexed = new Map<string, Array<readonly [number, string]>>();
  for (const line of lines) {
    const parsed = parseNameValueLine(line);
    if (parsed === undefined) continue;
    const match = INDEXED_HOOK.exec(parsed[0]);
    const name = match?.groups?.["name"] ?? parsed[0];
    const index = Number(match?.groups?.["index"] ?? 0);
    const bucket = indexed.get(name);
    if (bucket === undefined) indexed.set(name, [[index, parsed[1]]]);
    else bucket.push([index, parsed[1]]);
  }
  const hooks = new Map<string, readonly string[]>();
  for (const [name, elements] of indexed) {
    hooks.set(
      name,
      Object.freeze(
        [...elements].sort(([left], [right]) => left - right).map(([, command]) => command),
      ),
    );
  }
  return hooks;
}

/** Bind a tmux command to a hook name at one scope. */
export async function setHook(
  runtime: RuntimeContext,
  scope: HookScope,
  target: string | null | undefined,
  name: string,
  command: string,
): Promise<void> {
  await runCommand(runtime, ["set-hook", ...scopeArguments(scope, target), name, command]);
}

/** Remove every command bound to a hook name at one scope. */
export async function unsetHook(
  runtime: RuntimeContext,
  scope: HookScope,
  target: string | null | undefined,
  name: string,
): Promise<void> {
  await runCommand(runtime, ["set-hook", "-u", ...scopeArguments(scope, target), name]);
}
