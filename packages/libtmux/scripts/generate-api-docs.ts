import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  readApiSurface,
  readRootApiSurface,
  type ApiClass,
  type ApiDeclaration,
  type Member,
} from "./api_surface.js";
import { slugify } from "./markdown_anchors.js";
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
  // Slugified the way the heading itself will be, not approximated. A member
  // whose name carries punctuation — `[Symbol.iterator]` — is why the two have
  // to be the same function rather than two rules that happen to agree.
  return slugify(`${className}.${member}`);
}

interface MemberGroup {
  readonly members: readonly Member[];
  readonly name: string;
}

/** Keep overloads together so one documented member owns one stable anchor. */
function groupMembers(members: readonly Member[]): readonly MemberGroup[] {
  const grouped = new Map<string, Member[]>();
  for (const member of members) {
    const overloads = grouped.get(member.name);
    if (overloads === undefined) grouped.set(member.name, [member]);
    else overloads.push(member);
  }
  return [...grouped].map(([name, overloads]) => ({ members: overloads, name }));
}

function renderClass(entry: ApiClass): string {
  const lines: string[] = [`## ${entry.name}`, ""];
  if (entry.prose !== "") lines.push(entry.prose, "");

  const members = groupMembers(entry.members);
  const properties = members.filter(({ members: [member] }) => member?.kind !== "method");
  const methods = members.filter(({ members: [member] }) => member?.kind === "method");
  if (members.length > 0) {
    lines.push(
      members.map(({ name }) => `[\`${name}\`](#${anchorFor(entry.name, name)})`).join(" · "),
      "",
    );
  }

  for (const [heading, group] of [
    ["Properties", properties],
    ["Methods", methods],
  ] as const) {
    if (group.length === 0) continue;
    lines.push(`### ${heading}`, "");
    for (const memberGroup of group) {
      lines.push(`#### \`${entry.name}.${memberGroup.name}\``, "");
      for (const member of memberGroup.members) {
        lines.push("```ts", member.signature, "```", "");
        if (member.prose !== "") lines.push(member.prose, "");
        if (member.example !== undefined) {
          lines.push("```ts", member.example, "```", "");
        }
      }
    }
  }
  return lines.join("\n");
}

function renderDeclarations(title: string, declarations: readonly ApiDeclaration[]): string {
  const heading = (entry: ApiDeclaration): string =>
    entry.kind === "type" ? `${entry.name} type` : entry.name;
  const lines = [
    `## ${title}`,
    "",
    declarations
      .map((entry) => "[`" + entry.name + "`](#" + slugify(heading(entry)) + ")")
      .join(" · "),
    "",
  ];
  for (const declaration of declarations) {
    lines.push("### `" + declaration.name + "`" + (declaration.kind === "type" ? " type" : ""), "");
    for (const signature of declaration.signatures) lines.push("```ts", signature, "```", "");
    if (declaration.prose !== "") lines.push(declaration.prose, "");
    if (declaration.example !== undefined) {
      lines.push("```ts", declaration.example, "```", "");
    }
  }
  return lines.join("\n");
}

const surface = await readApiSurface();
const root = await readRootApiSurface();
const functions = root.filter((entry) => entry.kind === "function");
const types = root.filter((entry) => entry.kind === "type");
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
  renderDeclarations("Functions", functions),
  renderDeclarations("Scalar types", types),
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
    `${OUTPUT} matches the source: ${String(root.length)} root declarations, ${String(
      surface.length,
    )} classes, ${String(
      surface.reduce((total, entry) => total + entry.members.length, 0),
    )} members\n`,
  );
} else {
  await writeFile(target, wanted);
  process.stdout.write(
    `wrote ${OUTPUT}: ${String(root.length)} root declarations, ${String(
      surface.length,
    )} classes, ${String(
      surface.reduce((total, entry) => total + entry.members.length, 0),
    )} members\n`,
  );
}
