import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

/**
 * Resolve the Node that the emitted-package lanes run against.
 *
 * The floor is Node 22 and it is deliberately not substituted: a newer Node
 * says nothing about the version the package claims to support, so a lane that
 * quietly accepted one would report a pass it had not earned.
 *
 * One policy, shared by every lane that needs a Node: the variable if it is
 * set, a version manager if one is installed, and an error naming both
 * otherwise. Sharing it is what keeps a checkout from passing, failing, or
 * testing a different runtime depending on which lane happened to run.
 */
const NODE22_VARIABLE = "LIBTMUX_NODE22";

const MAJOR = 22;

function executableOnPath(name: string): string | undefined {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = resolve(entry, name);
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.error === undefined && probe.status === 0) return candidate;
  }
  return undefined;
}

function majorOf(executable: string): number | undefined {
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return undefined;
  const match = /^v(\d+)(?:\.|$)/.exec(probe.stdout.trim());
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

async function authenticate(candidate: string, source: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error(`${source} gave a Node path that is not absolute`);
  await access(candidate, constants.X_OK);
  const major = majorOf(candidate);
  if (major !== MAJOR) {
    throw new Error(
      `${source} gave Node ${major === undefined ? "of an unreadable version" : String(major)} at ${candidate}, not ${MAJOR}`,
    );
  }
  return realpath(candidate);
}

/** An absolute path to a Node 22, or an error saying how to provide one. */
export async function resolveNode22(): Promise<string> {
  const configured = process.env[NODE22_VARIABLE];
  if (configured !== undefined && configured !== "") {
    return authenticate(resolve(configured), NODE22_VARIABLE);
  }
  const mise = executableOnPath("mise");
  if (mise === undefined) {
    throw new Error(
      `point ${NODE22_VARIABLE} at a Node ${MAJOR} executable, or install mise so one can be resolved`,
    );
  }
  // `mise exec` runs against whichever Node 22 the machine already has, so a
  // developer who has one does not have to say where it lives.
  const located = spawnSync(
    mise,
    ["exec", "--quiet", `node@${MAJOR}`, "--", "node", "-p", "process.execPath"],
    { encoding: "utf8" },
  );
  if (located.error !== undefined || located.status !== 0) {
    throw new Error(
      `mise could not resolve node@${MAJOR}; point ${NODE22_VARIABLE} at one instead`,
    );
  }
  return authenticate(located.stdout.trim(), "mise");
}
