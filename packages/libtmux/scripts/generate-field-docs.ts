import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  WHERE_FIELDS_V1,
  WHERE_RELATIONS_V1,
  type WhereModel,
} from "../src/_generated/where_fields.js";
import { scalarOperatorNames } from "../src/_internal/selection/compile.js";
import { packageRoot } from "./package_root.js";

/**
 * Write the criteria reference from the table the compiler matches against.
 *
 * What a model can be filtered on was answerable only by editor completion or
 * by reading generated source, which leaves a caller writing criteria as data
 * — from a config file, or an MCP client — with nothing to read.
 *
 * Emitted from `WHERE_FIELDS_V1` and `WHERE_RELATIONS_V1` rather than written
 * beside them, so a field cannot be added without the reference growing with
 * it. `--check` fails when the committed file no longer matches.
 */

const OUTPUT = "docs/criteria.md";

const MODELS: readonly WhereModel[] = ["session", "window", "pane", "client"];

const TITLES: Readonly<Record<WhereModel, string>> = {
  client: "Client",
  pane: "Pane",
  session: "Session",
  window: "Window",
};

/** The operators a scalar criterion takes, read from the compiler itself. */
const SCALAR_OPERATORS: readonly string[] = [...scalarOperatorNames];

function renderModel(model: WhereModel): readonly string[] {
  // The release is shown only where it is not the floor, so the common case
  // stays scannable and the exception is the thing that catches the eye.
  const floor = WHERE_FIELDS_V1[model].reduce(
    (lowest, field) => (field.since < lowest ? field.since : lowest),
    WHERE_FIELDS_V1[model][0]?.since ?? "3.2a",
  );
  const fields = WHERE_FIELDS_V1[model]
    .map((field) =>
      // The release sits outside the code span: inside it, `name (3.7+)` reads
      // as the key a caller should write.
      field.since === floor
        ? `\`${field.criteriaName}\``
        : `\`${field.criteriaName}\` (${field.since}+)`,
    )
    .toSorted((left, right) => (left < right ? -1 : 1));
  const relations = WHERE_RELATIONS_V1[model]
    .map(
      (relation) =>
        `\`${relation.name}\` — ${
          relation.cardinality === "many" ? "`some`, `every`, `none`" : "`is`, `isNot`"
        } over ${relation.targetModel}s`,
    )
    .toSorted((left, right) => (left < right ? -1 : 1));

  const lines = [`## ${TITLES[model]}`, ""];
  lines.push(fields.join(" · "), "");
  if (relations.length > 0) {
    lines.push("Relations:", "");
    lines.push(...relations.map((relation) => `- ${relation}`), "");
  }
  return lines;
}

function render(): string {
  const lines = [
    "# Criteria reference",
    "",
    "Every field `.where()` accepts, per model, generated from the table the",
    "compiler matches against. A field is a key in a criteria object, holding a",
    "value to match exactly or an object of operators.",
    "",
    "```ts",
    'snapshot.panes.where({ currentCommand: { startsWith: "v" } });',
    "```",
    "",
    "A field marked with a release arrived in that tmux. Filtering on one an",
    "older server predates raises `VersionTooLow` naming the field, the release",
    "that has it, and the release running — rather than matching nothing, which",
    'reads as "no member has this" and is a different answer.',
    "",
    "The vocabulary tracks tmux rather than the Python library this package",
    "ports, so a field tmux has is a field you can filter on. What is left out",
    "is what does not describe an object: `#{host}` is the machine, and",
    "`#{sixel_support}` is how tmux was built. `displayMessage` expands any",
    "format tmux knows, including those:",
    "",
    "```ts",
    'await snapshot.panes.one().displayMessage("#{host}");',
    "```",
    "",
    "## Operators",
    "",
    "A scalar field takes these operators:",
    "",
    SCALAR_OPERATORS.map((name) => `\`${name}\``).join(" · "),
    "",
    'Several on one field must all hold. `mode` takes `"insensitive"` and folds',
    "case for the others rather than matching on its own, and `regex` takes",
    '`{ pattern, flags }` with `flags` one of `""`, `"m"`, `"s"` or `"ms"`.',
    "",
    "`AND`, `OR` and `NOT` each take an array of criteria for the same model.",
    "",
    "A relation takes a quantifier rather than an operator: `some`, `every` or",
    "`none` where it holds many, and `is` or `isNot` where it holds one.",
    "",
    "A name that is not one of these is refused, and the refusal names the",
    "position, lists the vocabulary that was expected, and suggests the nearest",
    "match.",
    "",
  ];
  for (const model of MODELS) lines.push(...renderModel(model));
  return lines.join("\n").trimEnd();
}

const target = join(packageRoot, OUTPUT);
const wanted = `${render()}\n`;
const models = String(MODELS.length);

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => undefined);
  if (current !== wanted) {
    process.stderr.write(
      `${OUTPUT} is out of date with the source. Run \`bun run docs:criteria\` and commit the result.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${OUTPUT} matches the source: ${models} models\n`);
} else {
  await writeFile(target, wanted);
  process.stdout.write(`wrote ${OUTPUT}: ${models} models\n`);
}
