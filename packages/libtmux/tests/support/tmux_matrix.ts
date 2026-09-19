import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The tmux releases CI proves this package against, read from CI itself.
 *
 * A test that hard-codes them tests a memory of the matrix. Reading the
 * workflow means adding a release to CI is what puts it in front of the
 * budget check, with no second list to keep in step.
 */
function readMatrix(): readonly string[] {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../../../.github/workflows/typescript.yml", import.meta.url)),
    "utf8",
  );
  const matrix = /tmux-version:\s*\[([^\]]+)\]/u.exec(workflow)?.[1];
  if (matrix === undefined) throw new Error("could not read the tmux matrix from typescript.yml");
  // The formatter adds a trailing comma once the list wraps, and the empty
  // final entry it splits into reaches `parseTmuxVersion` as a version named
  // "". `scripts/check-doc-claims.ts` reads the same list and needs the same
  // guard; these two are the only readers.
  return Object.freeze(
    matrix
      .split(",")
      .map((entry) => entry.trim().replaceAll('"', ""))
      .filter((entry) => entry !== ""),
  );
}

export const SUPPORTED_TMUX_VERSIONS = readMatrix();
