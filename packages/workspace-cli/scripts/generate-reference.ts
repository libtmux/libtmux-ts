/* eslint-disable no-await-in-loop -- Generated artifacts are small and written in stable order. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import { completionScript } from "../src/completions.ts";
import { completionShells } from "../src/parser.ts";
import { commandCatalog, commandMarkdown } from "../src/reference.ts";

const check = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check"))
  throw new Error("Expected --check or no arguments");
const catalog = commandCatalog();
const files = new Map([
  ["command-reference.md", commandMarkdown(catalog)],
  ["commands.json", JSON.stringify({ schema_version: 1, ...catalog }, null, 2) + "\n"],
  ...completionShells.map(
    (shell) =>
      [
        `completions/${shell === "zsh" ? "_tmux-workspace" : `tmux-workspace.${shell}`}`,
        completionScript(catalog, shell),
      ] as const,
  ),
]);
for (const [name, source] of files) {
  let text = source;
  if (name.endsWith(".md") || name.endsWith(".json")) {
    const formatted = await format(name, source);
    if (formatted.errors.length) throw new Error(JSON.stringify(formatted.errors));
    text = formatted.code;
  }
  const path = fileURLToPath(new URL(`../docs/${name}`, import.meta.url));
  if (check) {
    const actual = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (actual !== text) {
      process.stderr.write(`${name} is stale; run bun run docs:generate in the CLI package.\n`);
      process.exitCode = 1;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}
