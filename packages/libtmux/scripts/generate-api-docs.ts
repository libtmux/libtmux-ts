import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readApiSurface, type ApiClass } from "./api_surface.js";
import { packageRoot } from "./package_root.js";

/**
 * Write the API reference from the source that implements it.
 *
 * Generated here rather than by typedoc, which carries its own TypeScript and
 * cannot parse this one's. The reference is not a second description to keep in
 * step: it is the doc comments and their examples, which are already required
 * to exist and already compiled, arranged for reading.
 *
 * `--check` fails when the committed file no longer matches the source, so a
 * signature cannot change without the reference changing with it.
 */

const OUTPUT = "docs/api.md";

function anchorFor(className: string, member: string): string {
  return `${className.toLowerCase()}${member.toLowerCase()}`;
}

function renderClass(entry: ApiClass): string {
  const lines: string[] = [`## ${entry.name}`, ""];
  if (entry.prose !== "") lines.push(entry.prose, "");

  const properties = entry.members.filter((member) => member.kind !== "method");
  const methods = entry.members.filter((member) => member.kind === "method");
  if (entry.members.length > 0) {
    lines.push(
      entry.members
        .map((member) => `[\`${member.name}\`](#${anchorFor(entry.name, member.name)})`)
        .join(" · "),
      "",
    );
  }

  for (const [heading, group] of [
    ["Properties", properties],
    ["Methods", methods],
  ] as const) {
    if (group.length === 0) continue;
    lines.push(`### ${heading}`, "");
    for (const member of group) {
      lines.push(`#### \`${entry.name}.${member.name}\``, "");
      lines.push("```ts", member.signature, "```", "");
      if (member.prose !== "") lines.push(member.prose, "");
      if (member.example !== undefined) lines.push("```ts", member.example, "```", "");
    }
  }
  return lines.join("\n");
}

const surface = await readApiSurface();
const rendered = [
  "# API reference",
  "",
  "Every entry is generated from the source that implements it, and every",
  "example here is compiled against the package on each run — `bun run",
  "typecheck:symbols` is what keeps that true.",
  "",
  "Start with the [README](../README.md) for a reading order and recipes; this",
  "page is for looking one thing up.",
  "",
  surface.map((entry) => renderClass(entry)).join("\n"),
]
  .join("\n")
  .replace(/\n{3,}/gu, "\n\n")
  .trimEnd();

const target = join(packageRoot, OUTPUT);
const wanted = `${rendered}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => undefined);
  if (current !== wanted) {
    process.stderr.write(
      `${OUTPUT} is out of date with the source. Run \`bun run docs:api\` and commit the result.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `${OUTPUT} matches the source: ${String(surface.length)} classes, ${String(
      surface.reduce((total, entry) => total + entry.members.length, 0),
    )} members\n`,
  );
} else {
  await writeFile(target, wanted);
  process.stdout.write(
    `wrote ${OUTPUT}: ${String(surface.length)} classes, ${String(
      surface.reduce((total, entry) => total + entry.members.length, 0),
    )} members\n`,
  );
}
