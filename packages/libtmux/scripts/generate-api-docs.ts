import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EXEMPT,
  readApiSurface,
  readRootApiSurface,
  readRootExports,
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

/**
 * Turn a TSDoc `{@link}` into a link a reader can follow.
 *
 * The reference is doc comments arranged for reading, and a comment written
 * for an editor carries editor syntax. Passed through, it reaches the page as
 * literal `{@link Server.batch}` markup — thirteen of them, including four
 * bare member names that only mean something inside their class.
 *
 * A target this page documents becomes a link. One the package has but this
 * page does not — `TmuxCommandError` is thrown rather than documented here,
 * and `equals` is exempt — becomes code. A target that is neither is a typo,
 * and fails the run.
 */
const anchors = new Map<string, string>();
const unresolved: string[] = [];

function resolveLinks(prose: string, className?: string): string {
  // TSDoc also spells this `{@link target | text}`; the text replaces the
  // target in the rendering, and the target is still what has to resolve.
  return prose.replace(
    /\{@link\s+([^}|\s]+)(?:\s*\|\s*([^}]*?))?\s*\}/gu,
    (_match, target: string, label: string | undefined) => {
      const qualified =
        className === undefined || target.includes(".") ? target : `${className}.${target}`;
      const shown = label === undefined || label === "" ? `\`${target}\`` : label;
      const anchor = anchors.get(qualified) ?? anchors.get(target);
      if (anchor !== undefined) return `[${shown}](#${anchor})`;
      const segments = target.split(".");
      const known = exported.has(segments[0] ?? "") || EXEMPT.has(segments.at(-1) ?? "");
      if (!known) unresolved.push(target);
      return shown;
    },
  );
}

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
  if (entry.prose !== "") lines.push(resolveLinks(entry.prose, entry.name), "");

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
        if (member.prose !== "") lines.push(resolveLinks(member.prose, entry.name), "");
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
    if (declaration.prose !== "") lines.push(resolveLinks(declaration.prose), "");
    if (declaration.example !== undefined) {
      lines.push("```ts", declaration.example, "```", "");
    }
  }
  return lines.join("\n");
}

/**
 * Every root export that has no entry of its own, in one table.
 *
 * Derived from the root module: a name added there appears here, with the
 * first sentence of its doc comment, and a name with no doc comment fails the
 * run. Classes and `Selection` have their own sections.
 */
function renderOtherExports(
  entries: readonly { kind: string; name: string; summary: string }[],
  files: ReadonlyMap<string, string>,
): string {
  const cells = entries.map((entry) => [
    `\`${entry.name}\``,
    entry.kind,
    resolveLinks(entry.summary).replaceAll("|", "\\|"),
    `\`${files.get(entry.name) ?? ""}\``,
  ]);
  // Padded the way the repository's formatter pads a table, so formatting the
  // generated page changes nothing and `docs:api:check` agrees with `format:check`.
  const header = ["Name", "Kind", "Summary", "Declared in"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]): string =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const rows = [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...cells.map(line),
  ];
  return [
    "## Other exports",
    "",
    "Everything else the package root exports: options and event types, the",
    "error classes, the direction and scope constants, and the deprecated",
    "aliases, which stay exported in 0.1.x with no removal scheduled. Each is",
    "described by its doc comment in the file named here.",
    "",
    ...rows,
    "",
  ].join("\n");
}

const surface = await readApiSurface();
const root = await readRootApiSurface();
const functions = root.filter((entry) => entry.kind === "function");
const constants = root.filter((entry) => entry.kind === "const");
const types = root.filter((entry) => entry.kind === "type");
const rootExports = await readRootExports();

const exported = new Set(
  [
    ...(await readFile(join(packageRoot, "src/index.ts"), "utf8")).matchAll(
      /^export(?:\s+type)?\s*\{([^}]*)\}/gmu,
    ),
  ]
    .flatMap(([, names]) => (names ?? "").split(","))
    .map((name) => name.replace(/\btype\b/u, "").trim())
    .filter((name) => /^[A-Za-z_]\w*$/u.test(name)),
);
for (const entry of root) {
  anchors.set(entry.name, slugify(entry.kind === "type" ? `${entry.name} type` : entry.name));
}
for (const entry of surface) {
  anchors.set(entry.name, slugify(entry.name));
  for (const member of entry.members) {
    anchors.set(`${entry.name}.${member.name}`, anchorFor(entry.name, member.name));
  }
}
const documented = new Set([
  ...root.map((entry) => entry.name),
  ...surface.map((entry) => entry.name),
]);
const otherExports = rootExports.filter((entry) => !documented.has(entry.name));
const otherFiles = new Map(otherExports.map((entry) => [entry.name, entry.file]));
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
  "It covers every name the `libtmux` root exports: the classes, functions and",
  "constants below have entries of their own, and the rest are in the last",
  "table. The list is read from the root module, so a new export cannot be",
  "left out. The package publishes further subpaths that this page does not",
  "list — `libtmux/testing` for the record-and-replay doubles, `libtmux/engine`",
  "for supplying a transport, and `libtmux/selection` for query documents —",
  "each introduced in the README where it is used. A name missing from this",
  "page is on one of those.",
  "",
  renderDeclarations("Functions", functions),
  renderDeclarations("Constants", constants),
  renderDeclarations("Scalar types", types),
  surface.map((entry) => renderClass(entry)).join("\n"),
  renderOtherExports(otherExports, otherFiles),
]
  .join("\n")
  .replace(/\n{3,}/gu, "\n\n")
  .trimEnd();

if (unresolved.length > 0) {
  process.stderr.write(
    `A doc comment links to a name the package does not export: ${[...new Set(unresolved)].join(", ")}\n`,
  );
  process.exit(1);
}

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
