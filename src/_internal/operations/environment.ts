import type { EnvironmentScope, EnvironmentValue, SetEnvironmentOptions } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { TmuxCommandError } from "../../exc.js";
import { runCommand } from "./command.js";

function scopeArguments(
  scope: EnvironmentScope,
  target: string | null | undefined,
): readonly string[] {
  if (scope === "server") return ["-g"];
  return target == null ? [] : ["-t", target];
}

/**
 * Read one line of `show-environment` output.
 *
 * tmux writes a set variable as `NAME=value` and a variable marked for removal
 * as `-NAME`. The value is unquoted and may itself contain `=` and spaces, so
 * only the first `=` separates the two.
 */
function parseEnvironmentLine(line: string): readonly [string, EnvironmentValue] | undefined {
  if (line === "") return undefined;
  if (line.startsWith("-")) return [line.slice(1), null];
  const separator = line.indexOf("=");
  // A bare name with no `=` and no `-` is not a shape tmux documents; treating
  // it as present-but-empty keeps a future tmux from losing the variable.
  if (separator === -1) return [line, ""];
  return [line.slice(0, separator), line.slice(separator + 1)];
}

/**
 * Every variable in a tmux environment.
 *
 * A session's environment routinely carries removal marks — tmux's
 * `update-environment` puts `SSH_CONNECTION`, `XAUTHORITY` and friends there on
 * its own — so `null` is a normal value here rather than an edge case.
 */
export async function showEnvironment(
  runtime: RuntimeContext,
  scope: EnvironmentScope,
  target?: string | null,
): Promise<ReadonlyMap<string, EnvironmentValue>> {
  const lines = await runCommand(runtime, ["show-environment", ...scopeArguments(scope, target)]);

  const environment = new Map<string, EnvironmentValue>();
  for (const line of lines) {
    const parsed = parseEnvironmentLine(line);
    if (parsed !== undefined) environment.set(parsed[0], parsed[1]);
  }
  return environment;
}

/**
 * One variable, or `undefined` when the environment does not carry it.
 *
 * tmux answers a name it does not know by failing with `unknown variable`,
 * which is an answer rather than a fault, so it becomes `undefined` here. Every
 * other failure still throws.
 */
export async function getEnvironment(
  runtime: RuntimeContext,
  scope: EnvironmentScope,
  target: string | null | undefined,
  name: string,
): Promise<EnvironmentValue | undefined> {
  let lines: readonly string[];
  try {
    lines = await runCommand(runtime, ["show-environment", ...scopeArguments(scope, target), name]);
  } catch (error) {
    if (error instanceof TmuxCommandError && error.stderrIncludes("unknown variable")) {
      return undefined;
    }
    throw error;
  }
  for (const line of lines) {
    const parsed = parseEnvironmentLine(line);
    if (parsed?.[0] === name) return parsed[1];
  }
  return undefined;
}

/** Set a variable in a tmux environment. */
export async function setEnvironment(
  runtime: RuntimeContext,
  scope: EnvironmentScope,
  target: string | null | undefined,
  name: string,
  value: string,
  options: SetEnvironmentOptions = {},
): Promise<void> {
  await runCommand(
    runtime,
    [
      "set-environment",
      ...scopeArguments(scope, target),
      ...(options.expandFormat === true ? ["-F"] : []),
      ...(options.hidden === true ? ["-h"] : []),
      name,
      value,
    ],
    options,
  );
}

/** Drop a variable from a tmux environment entirely. */
export async function unsetEnvironment(
  runtime: RuntimeContext,
  scope: EnvironmentScope,
  target: string | null | undefined,
  name: string,
): Promise<void> {
  await runCommand(runtime, ["set-environment", "-u", ...scopeArguments(scope, target), name]);
}

/**
 * Mark a variable for removal from the environment of processes tmux starts.
 *
 * This is not `unsetEnvironment`: the entry stays, and what it now says is
 * "unset this before spawning", which is how tmux keeps a stale `SSH_AUTH_SOCK`
 * out of a new pane.
 */
export async function removeEnvironment(
  runtime: RuntimeContext,
  scope: EnvironmentScope,
  target: string | null | undefined,
  name: string,
): Promise<void> {
  await runCommand(runtime, ["set-environment", "-r", ...scopeArguments(scope, target), name]);
}
