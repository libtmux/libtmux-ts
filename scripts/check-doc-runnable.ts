import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tie a documented recipe to code that actually runs against tmux.
 *
 * Compiling a snippet proves it typechecks, which is not the same as proving
 * it works: a snippet can satisfy every signature and still deadlock, or wait
 * for a marker that the command it sends never prints. The examples under
 * `examples/` do not have that problem — the integration suite runs each of
 * them against a real, isolated tmux server and asserts on the result.
 *
 * So a recipe marked
 *
 *     <!-- runs: examples/agent.ts -->
 *
 * has to be drawn from that file: every line it shows must appear there, in
 * order. The README stays free to leave out the error handling and the
 * commentary, and cannot show a line that no longer exists in the code the
 * suite executes.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface MarkedBlock {
  readonly code: readonly string[];
  readonly line: number;
  readonly source: string;
}

function markedBlocks(markdown: string): readonly MarkedBlock[] {
  const blocks: MarkedBlock[] = [];
  const lines = markdown.split("\n");
  let source: string | undefined;
  let open: number | undefined;

  for (const [index, line] of lines.entries()) {
    const marker = /^<!--\s*runs:\s*(\S+)\s*-->$/u.exec(line.trim());
    if (marker) {
      source = marker[1];
      continue;
    }
    if (open === undefined) {
      if (source !== undefined && line.trim() === "```ts") open = index;
      else if (line.trim() !== "" && !line.trim().startsWith("```")) source = undefined;
      continue;
    }
    if (line.trim() !== "```") continue;
    if (source !== undefined) {
      blocks.push({ code: lines.slice(open + 1, index), line: open + 2, source });
    }
    open = undefined;
    source = undefined;
  }
  return blocks;
}

/** Comments and blank lines are presentation; they are not what runs. */
function significant(lines: readonly string[]): readonly string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*"));
}

const listed = await new Bun.$.Shell()`git ls-files "*.md"`.cwd(repositoryRoot).text();
const files = listed.split("\n").filter((line) => line !== "");

const failures: string[] = [];
let verified = 0;

for (const file of files) {
  // eslint-disable-next-line no-await-in-loop -- one document at a time; failures are reported in file order.
  const markdown = await Bun.file(join(repositoryRoot, file)).text();

  for (const block of markedBlocks(markdown)) {
    const where = `${file}:${String(block.line)}`;
    const sourcePath = join(repositoryRoot, block.source);

    if (!block.source.startsWith("examples/") || !existsSync(sourcePath)) {
      failures.push(
        `${where}: marked as running ${block.source}, which is not an executed example`,
      );
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- one example per marked block, read where it is used.
    const executed = significant((await Bun.file(sourcePath).text()).split("\n"));
    let cursor = 0;
    let missing: string | undefined;
    for (const line of significant(block.code)) {
      const found = executed.indexOf(line, cursor);
      if (found === -1) {
        missing = line;
        break;
      }
      cursor = found + 1;
    }

    if (missing === undefined) verified += 1;
    else
      failures.push(`${where}: ${block.source} does not run this line, in this order: ${missing}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Documented recipes drifted from the code that runs them:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  `Documented recipes match their executed examples: ${String(verified)} blocks\n`,
);
