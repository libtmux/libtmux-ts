import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCiMatrix } from "../../../../scripts/ci_matrix.js";

/**
 * The tmux releases CI proves this package against, read from the CI manifest.
 *
 * A test that hard-codes them tests a memory of the matrix. Reading the
 * manifest means adding a release to CI is what puts it in front of the
 * budget check, with no second list to keep in step. The manifest is also what
 * the workflow's plan reads, so the lanes and this list cannot differ.
 */
function readMatrix(): readonly string[] {
  const matrix = parseCiMatrix(
    readFileSync(
      fileURLToPath(new URL("../../../../.github/ci-matrix.txt", import.meta.url)),
      "utf8",
    ),
  );
  return Object.freeze(
    [...matrix.supported, ...matrix.preview, ...matrix.development]
      // A development lane is a branch; the version it reports is a `next-X.Y` build.
      .map((entry) => (matrix.development.includes(entry) ? "next-3.9" : entry))
      // A release with no tag upstream is built from its `release_` branch.
      .map((entry) => entry.replace(/^release_/u, "")),
  );
}

export const SUPPORTED_TMUX_VERSIONS = readMatrix();
