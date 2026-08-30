import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hold a doc comment against the symbol it describes.
 *
 * Seven gates check whether documentation resolves, compiles, or runs; none
 * checked that a block is attached to anything. A block closed on one line and
 * reopened on the next documents nothing — TypeScript keeps the last one — so
 * the prose reaches no editor, no `docs:api` output, and no reader. Nine had
 * drifted that way: one `@param` stranded on a private field while the
 * constructor parameter it names went undocumented, and two describing code
 * that had since been rewritten to work the other way.
 *
 * A blank line between the two stays legal. That block is a heading for what
 * follows rather than a description of it.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED = new Set(["_generated", "coverage", "dist", "fixtures", "node_modules"]);

function* sources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

const failures: string[] = [];
let scanned = 0;

for (const path of sources(repositoryRoot)) {
  const lines = readFileSync(path, "utf8").split("\n");
  scanned += 1;
  for (const [index, line] of lines.entries()) {
    if (line.trimEnd().endsWith("*/") && lines[index + 1]?.trimStart().startsWith("/**")) {
      failures.push(`${path.slice(repositoryRoot.length)}:${String(index + 2)}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `A doc comment opens directly below another, so the first documents nothing:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(`Doc comments describe the symbol below them: ${String(scanned)} files\n`);
