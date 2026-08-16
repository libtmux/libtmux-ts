import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hold the dependabot configuration to the manifests this workspace actually
 * has.
 *
 * The file arrived as GitHub's unedited template, whose `package-ecosystem` is
 * the empty string and whose one directory is a placeholder. Merged as written
 * it would have configured nothing while reading as configured — the failure
 * this repository keeps meeting, where every step passes and none of them did
 * the work.
 *
 * Nothing else here could notice. `docs:claims` reads Markdown, `lint` reads
 * TypeScript, and a workflow that never runs dependabot cannot report that
 * dependabot is asleep. So the claims are checked here, all of them answerable
 * from the tree:
 *
 * - an ecosystem is one dependabot defines, not a placeholder;
 * - a directory it is pointed at holds the manifest that ecosystem reads;
 * - every manifest the root `workspaces` globs resolve to is covered.
 *
 * The last is the one that earns the file. `packages/*` in the configuration
 * picks up a new package on its own; a workspace added beside it does not, and
 * this fails naming the manifest nothing updates.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = ".github/dependabot.yml";

/**
 * What each ecosystem reads, so pointing it somewhere else is an error rather
 * than a silent no-op.
 *
 * Only the ecosystems this repository has any use for. Naming the other fifty
 * would be a list to maintain against a document nobody here reads, and a
 * typo'd `githubactions` fails as loudly against a short list as a long one.
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

/**
 * Every manifest in the workspace, from the root manifest's own globs.
 *
 * Read rather than listed: a package added under `packages/` is one this has to
 * cover, and a list written here would be a second place to remember.
 */
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

// Workflow pins rot the same way a dependency does, and this repository pins
// every action by tag. Nothing else asks whether those tags moved.
if (!(covered.get("github-actions") ?? new Set<string>()).has("")) {
  failures.push(`${configPath}: no github-actions entry covers the workflows at the root`);
}

if (failures.length > 0) {
  process.stderr.write(
    `Continuous integration configuration the repository does not support:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

// `dot: true`, or the scan walks past `.github` and reports the count as zero
// — a summary line that reads like a pass while having counted nothing.
const workflows = await Array.fromAsync(
  new Bun.Glob("workflows/*.yml").scan({ cwd: join(repositoryRoot, ".github"), dot: true }),
);
if (workflows.length === 0) {
  process.stderr.write(`${configPath}: no workflows were found to keep pinned\n`);
  process.exit(1);
}

process.stdout.write(
  `CI configuration holds: ${String(updates.length)} dependabot entries over ${String(manifests.length)} workspace manifests and ${String(workflows.length)} workflows\n`,
);
