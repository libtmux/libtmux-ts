import { join } from "node:path";

import { packageRoot } from "../package_root.js";
import { fencedBlocks, typecheckExamples } from "./example_harness.js";

/**
 * Typecheck every TypeScript block in the README against the package's own API.
 *
 * A README is the first thing anyone runs, and a snippet that does not compile
 * is worse than no snippet: it is a documented lie about the signature. Nothing
 * compiled these, and one of them had passed `setBuffer` its arguments in the
 * wrong order for as long as it had existed.
 */

const readme = await Bun.file(join(packageRoot, "README.md")).text();
const blocks = fencedBlocks(readme, (line) => `README.md:${String(line)}`);
if (blocks.length === 0) throw new Error("no ```ts blocks found in the README");

await typecheckExamples(blocks, "readme");

process.stdout.write(
  `README examples typecheck: ${String(blocks.length)} blocks, ${String(
    blocks.reduce((total, block) => total + block.code.split("\n").length, 0),
  )} lines\n`,
);
