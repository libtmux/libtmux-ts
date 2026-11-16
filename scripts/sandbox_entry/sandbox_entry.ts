/** A script that may start tmux has to enter the test sandbox, or say in `needsNoSandbox` why not. */

const startsTmux =
  /\bnew Server\(|\bTestServer\b|\bwithOwnedRunRoot\b|\bassertOwnedSocketPath\b|["'`]tmux(?:["'`]|\s+(?:-\S|[a-z]+-[a-z]+))|\btmuxBin\b|\btmuxExecutable\b/u;
const entersSandbox = /\b(?:enterSandbox|runSupervisor)\(/u;
/** Calls that refuse a process outside the sandbox, so a script making them has to be in one. */
const refusesOutside =
  /\bTestServer\.(?:create|run)\(|\bwithOwnedRunRoot\(|\bassertOwnedSocketPath\(/u;
const IMPORTED = "imported by";

/** `source` as code: `code` has no comments, and `bare` has empty strings as well. */
export function scanSource(source: string): { readonly bare: string; readonly code: string } {
  let code = "";
  let bare = "";
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source.charAt(end) !== char) {
        end += source.charAt(end) === "\\" ? 2 : 1;
      }
      code += source.slice(index, end + 1);
      bare += `${char}${char}`;
      index = end + 1;
    } else {
      code += char;
      bare += char;
      index += 1;
    }
  }
  return { bare, code };
}

/** Every way `scripts` (path to source) and the `needsNoSandbox` table disagree with the rule. */
export function sandboxEntryFailures(
  scripts: ReadonlyMap<string, string>,
  needsNoSandbox: Readonly<Record<string, string>>,
): readonly string[] {
  const failures: string[] = [];
  for (const [file, source] of scripts) {
    const { bare, code } = scanSource(source);
    if (!startsTmux.test(code) || entersSandbox.test(bare) || file in needsNoSandbox) continue;
    failures.push(
      `${file}: starts tmux, so it calls enterSandbox from the testkit, or is listed in needsNoSandbox with the reason it needs none`,
    );
  }
  for (const [file, reason] of Object.entries(needsNoSandbox)) {
    const source = scripts.get(file);
    const scanned = source === undefined ? undefined : scanSource(source);
    if (
      scanned === undefined ||
      !startsTmux.test(scanned.code) ||
      entersSandbox.test(scanned.bare)
    ) {
      failures.push(
        `${file}: listed in needsNoSandbox but it starts no tmux or enters the sandbox`,
      );
    } else if (refusesOutside.test(scanned.bare) && !reason.startsWith(IMPORTED)) {
      failures.push(
        `${file}: listed in needsNoSandbox but it calls a fixture that refuses a process outside the sandbox`,
      );
    }
  }
  return failures;
}
