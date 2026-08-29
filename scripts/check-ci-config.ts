import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hold the dependabot configuration to the manifests this workspace has.
 *
 * Nothing else can: a placeholder ecosystem configures nothing while reading as
 * configured, and no gate runs dependabot. Three claims, all answerable from
 * the tree:
 *
 * - an ecosystem is one dependabot defines, not a placeholder;
 * - a directory it is pointed at holds the manifest that ecosystem reads;
 * - every manifest the root `workspaces` globs resolve to is covered.
 *
 * The last earns the file. `packages/*` picks up a new package on its own; a
 * workspace added beside it does not.
 *
 * What this deliberately does not claim: that every ecosystem dependabot could
 * file for is configured. Action pins are checked below, after the workflow
 * set has been found, so a version tag cannot silently move the code CI runs.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = ".github/dependabot.yml";

/**
 * What each ecosystem reads, so pointing it elsewhere is an error not a no-op.
 *
 * Only the ecosystems this repository uses; a typo fails as loudly against a
 * short list as a long one.
 */
const ecosystems = new Map<string, (directory: string) => boolean>([
  ["bun", (directory) => existsSync(join(directory, "package.json"))],
  ["github-actions", (directory) => existsSync(join(directory, ".github/workflows"))],
]);

interface UpdateEntry {
  readonly directories?: unknown;
  readonly directory?: unknown;
  readonly "package-ecosystem"?: unknown;
  readonly schedule?: unknown;
}

interface WorkflowStep {
  readonly name?: unknown;
  readonly run?: unknown;
  readonly uses?: unknown;
  readonly with?: Readonly<Record<string, unknown>>;
}

const failures: string[] = [];

/** Directories a `directories` entry names, with `*` expanded against the tree. */
async function expand(pattern: string): Promise<readonly string[]> {
  const relativePattern = pattern.replace(/^\//u, "");
  if (relativePattern === "") return [""];
  if (!relativePattern.includes("*")) return [relativePattern];
  const matches = await Array.fromAsync(
    new Bun.Glob(`${relativePattern}/package.json`).scan({ cwd: repositoryRoot }),
  );
  return matches.map((match) => dirname(match)).sort();
}

const source = await Bun.file(join(repositoryRoot, configPath)).text();
const parsed = Bun.YAML.parse(source) as { updates?: unknown; version?: unknown };

if (parsed.version !== 2) {
  failures.push(`${configPath}: version must be 2, not ${JSON.stringify(parsed.version)}`);
}

const updates: readonly UpdateEntry[] = Array.isArray(parsed.updates)
  ? (parsed.updates as UpdateEntry[])
  : [];
if (updates.length === 0) failures.push(`${configPath}: no updates are configured`);

/** Every directory a working entry covers, by ecosystem. */
const covered = new Map<string, Set<string>>();

for (const [index, entry] of updates.entries()) {
  const where = `${configPath}: updates[${String(index)}]`;
  const ecosystem = entry["package-ecosystem"];

  if (typeof ecosystem !== "string" || ecosystem === "") {
    failures.push(
      `${where}: package-ecosystem is ${JSON.stringify(ecosystem)}, which configures nothing`,
    );
    continue;
  }
  const holdsManifest = ecosystems.get(ecosystem);
  if (holdsManifest === undefined) {
    failures.push(
      `${where}: package-ecosystem ${ecosystem} is not one this repository has a manifest for (${[...ecosystems.keys()].join(", ")})`,
    );
    continue;
  }
  if (entry.schedule === undefined) failures.push(`${where}: has no schedule`);

  if (entry.directory !== undefined && entry.directories !== undefined) {
    failures.push(`${where}: sets both directory and directories`);
    continue;
  }
  const listed =
    entry.directories !== undefined
      ? Array.isArray(entry.directories)
        ? (entry.directories as unknown[])
        : [entry.directories]
      : [entry.directory ?? "/"];

  for (const raw of listed) {
    if (typeof raw !== "string") {
      failures.push(`${where}: directory ${JSON.stringify(raw)} is not a string`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- a handful of patterns, reported in order.
    const expanded = await expand(raw);
    if (expanded.length === 0) {
      failures.push(`${where}: ${raw} matches no directory in the tree`);
      continue;
    }
    for (const directory of expanded) {
      const absolute = join(repositoryRoot, directory);
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        failures.push(`${where}: ${raw} names ${directory || "/"}, which is not a directory`);
        continue;
      }
      if (!holdsManifest(absolute)) {
        failures.push(
          `${where}: ${ecosystem} is pointed at ${directory || "/"}, which has no manifest it reads`,
        );
        continue;
      }
      let directories = covered.get(ecosystem);
      if (directories === undefined) {
        directories = new Set<string>();
        covered.set(ecosystem, directories);
      }
      directories.add(directory);
    }
  }
}

/** Every manifest in the workspace, from the root manifest's own globs. */
async function workspaceManifests(): Promise<readonly string[]> {
  const root = (await Bun.file(join(repositoryRoot, "package.json")).json()) as {
    workspaces?: readonly string[];
  };
  const directories = new Set<string>([""]);
  for (const pattern of root.workspaces ?? []) {
    // eslint-disable-next-line no-await-in-loop -- two patterns, expanded in order.
    for (const directory of await expand(pattern)) directories.add(directory);
  }
  return [...directories].sort();
}

const bunCovered = covered.get("bun") ?? new Set<string>();
const manifests = await workspaceManifests();
for (const directory of manifests) {
  if (!bunCovered.has(directory)) {
    failures.push(
      `${configPath}: ${join(directory, "package.json")} is a workspace manifest no bun entry covers`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Continuous integration configuration the repository does not support:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

// `dot: true`, or the scan walks past `.github` and counts zero.
const workflows = await Array.fromAsync(
  new Bun.Glob("workflows/*.yml").scan({ cwd: join(repositoryRoot, ".github"), dot: true }),
);
if (workflows.length === 0) {
  process.stderr.write(`${configPath}: no workflows were found to keep pinned\n`);
  process.exit(1);
}

for (const workflow of workflows) {
  // eslint-disable-next-line no-await-in-loop -- each workflow gets an exact diagnostic.
  const source = await Bun.file(join(repositoryRoot, ".github", workflow)).text();
  for (const [index, reference] of source.split("\n").entries()) {
    const line = index + 1;
    const found = /^\s*(?:-\s*)?uses:\s*[^@\s]+@([^\s#]+)/u.exec(reference);
    if (found === null) continue;
    const revision = found[1];
    if (revision === undefined || !/^[0-9a-f]{40}$/u.test(revision)) {
      failures.push(
        `.github/${workflow}:${String(line)} pins an action by ${JSON.stringify(revision)}, not a full commit SHA`,
      );
    }
  }
}

const publishPath = join(repositoryRoot, ".github/workflows/publish.yml");
const publishSource = await Bun.file(publishPath).text();
const publishDocument = Bun.YAML.parse(publishSource) as {
  readonly on?: { readonly workflow_dispatch?: unknown };
  readonly jobs?: { readonly publish?: { readonly steps?: unknown } };
};
const rawPublishSteps = publishDocument.jobs?.publish?.steps;
const publishSteps: readonly WorkflowStep[] = Array.isArray(rawPublishSteps)
  ? (rawPublishSteps as WorkflowStep[])
  : [];

const setupNodeStep = (step: WorkflowStep, version: string): boolean =>
  typeof step.uses === "string" &&
  step.uses.startsWith("actions/setup-node@") &&
  step.with?.["node-version"] === version;
const node22 = publishSteps.findIndex((step) => setupNodeStep(step, "22"));
const node22Path = publishSteps.findIndex(
  (step) => typeof step.run === "string" && step.run.includes("LIBTMUX_NODE22=$(which node)"),
);
const node24 = publishSteps.findIndex(
  (step) =>
    setupNodeStep(step, "24") && step.with?.["registry-url"] === "https://registry.npmjs.org",
);
if (node22 < 0 || node22Path <= node22 || node24 <= node22Path) {
  failures.push(
    ".github/workflows/publish.yml: must capture an authenticated Node 22 path before configuring Node 24 for npm trusted publishing",
  );
}

const packageCheck = publishSteps.find(
  (step) => step.name === "Build and check every package",
)?.run;
if (
  typeof packageCheck !== "string" ||
  !/for package in libtmux mcp workspace; do[\s\S]*?\(\s*cd "packages\/\$package"\s*&&\s*bun run test:package\s*&&\s*bun run test:install\s*\)[\s\S]*?done/u.test(
    packageCheck,
  )
) {
  failures.push(
    ".github/workflows/publish.yml: must run test:install after test:package for libtmux, mcp, and workspace",
  );
}

const dispatch = publishDocument.on?.workflow_dispatch;
if (
  typeof dispatch === "object" &&
  dispatch !== null &&
  "inputs" in dispatch &&
  Object.keys((dispatch as { readonly inputs?: unknown }).inputs ?? {}).length > 0
) {
  failures.push(
    ".github/workflows/publish.yml: workflow_dispatch must not expose a live-publish input",
  );
}

const releaseCoordinator = publishSteps.find((step) => step.name === "Coordinate release")?.run;
if (releaseCoordinator !== "bun scripts/publish-release.ts") {
  failures.push(
    ".github/workflows/publish.yml: must delegate dry-run and tag publishing to scripts/publish-release.ts",
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `Continuous integration configuration the repository does not support:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  `CI configuration holds: ${String(updates.length)} dependabot entries over ${String(manifests.length)} workspace manifests and ${String(workflows.length)} workflows\n`,
);
