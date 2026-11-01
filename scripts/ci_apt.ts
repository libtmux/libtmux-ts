/**
 * Raw `apt-get` calls in the CI configuration.
 *
 * `scripts/apt-get.sh` bounds apt-get with a timeout and moves to another
 * mirror when one hangs (actions/runner-images#15040). That protects a job only
 * while every call goes through it, so a workflow or composite action whose
 * `run` script calls `apt-get` or `apt` itself is refused.
 */

/**
 * `apt-get` or `apt` in command position: at the start of a line, after a
 * separator or a shell keyword, with `sudo`, its flags and `NAME=value`
 * assignments allowed before it. A path such as `scripts/apt-get.sh` and a
 * quoted string such as `echo "apt-get"` are not in command position.
 */
const RAW_APT =
  /(?:^|[;&|(!`]|\b(?:then|do|else|elif|if)\s)\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\w+=\S*\s+)*(apt-get|apt)(?=\s|$)/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a list of steps sits in the file, and the list. */
function stepLists(document: unknown): readonly (readonly [string, unknown])[] {
  if (!isRecord(document)) return [];
  const lists: (readonly [string, unknown])[] = [];
  if (isRecord(document.jobs)) {
    for (const [name, job] of Object.entries(document.jobs)) {
      if (isRecord(job)) lists.push([`job ${name}`, job.steps]);
    }
  }
  if (isRecord(document.runs)) lists.push(["runs", document.runs.steps]);
  return lists;
}

/** The first raw `apt-get` or `apt` command in a `run` script, if any. */
function rawAptCommand(script: string): string | undefined {
  // A trailing backslash joins the next line, so `sudo \` then `apt-get` is one command.
  for (const line of script.replaceAll("\\\n", " ").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const found = RAW_APT.exec(trimmed);
    if (found !== null) return found[1];
  }
  return undefined;
}

/**
 * One failure for every step of a workflow or composite action that runs
 * `apt-get` or `apt` without `scripts/apt-get.sh`.
 *
 * Takes the parsed document, not the text: the unit tests run where `Bun` is not
 * a global, so the caller parses the YAML and this stays plain TypeScript.
 *
 * @param file - The path to name in each failure.
 * @param document - The parsed YAML of the workflow or composite action.
 */
export function rawAptFailures(file: string, document: unknown): readonly string[] {
  const failures: string[] = [];
  for (const [where, steps] of stepLists(document)) {
    if (!Array.isArray(steps)) continue;
    for (const [index, step] of (steps as unknown[]).entries()) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      const command = rawAptCommand(step.run);
      if (command === undefined) continue;
      const label = typeof step.name === "string" ? JSON.stringify(step.name) : String(index + 1);
      failures.push(
        `${file}: ${where}, step ${label} runs ${command} directly; run it through scripts/apt-get.sh`,
      );
    }
  }
  return failures;
}
