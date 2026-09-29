import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { executableOnPath } from "./node22.js";

/**
 * Resolve the Deno that the Deno lanes run against.
 *
 * The floor is exact. On Deno before 2.9.7, a cancelled command's
 * `TmuxTransportError.signal` reads `undefined` and a process that ignores
 * `SIGTERM` keeps running; a newer Deno says nothing about the release the
 * package claims.
 *
 * The same policy as `resolveNode22`: the variable if it is set, mise if it is
 * installed, and an error naming both otherwise.
 */
const DENO_VARIABLE = "LIBTMUX_DENO";

export const DENO_FLOOR = "2.9.7";

function versionOf(executable: string): string | undefined {
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return undefined;
  return /^deno (\S+)/u.exec(probe.stdout)?.[1];
}

async function authenticate(candidate: string, source: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error(`${source} gave a Deno path that is not absolute`);
  await access(candidate, constants.X_OK);
  const version = versionOf(candidate);
  if (version !== DENO_FLOOR) {
    throw new Error(
      `${source} gave Deno ${version ?? "of an unreadable version"} at ${candidate}, not ${DENO_FLOOR}`,
    );
  }
  return realpath(candidate);
}

/** An absolute path to Deno {@link DENO_FLOOR}, or an error saying how to provide one. */
export async function resolveDeno(): Promise<string> {
  const configured = process.env[DENO_VARIABLE];
  if (configured !== undefined && configured !== "") {
    return authenticate(resolve(configured), DENO_VARIABLE);
  }
  const mise = executableOnPath("mise");
  if (mise === undefined) {
    throw new Error(
      `point ${DENO_VARIABLE} at a Deno ${DENO_FLOOR} executable, or install mise so one can be resolved`,
    );
  }
  const located = spawnSync(
    mise,
    ["exec", "--quiet", `deno@${DENO_FLOOR}`, "--", "deno", "eval", "console.log(Deno.execPath())"],
    { encoding: "utf8" },
  );
  if (located.error !== undefined || located.status !== 0) {
    throw new Error(
      `mise could not resolve deno@${DENO_FLOOR}; point ${DENO_VARIABLE} at one instead`,
    );
  }
  return authenticate(located.stdout.trim(), "mise");
}
