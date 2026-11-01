import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rawAptFailures } from "./ci_apt.js";

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
 * The same pass refuses a `run` script that calls `apt-get` without
 * `scripts/apt-get.sh`.
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
  readonly "continue-on-error"?: unknown;
  readonly if?: unknown;
  readonly name?: unknown;
  readonly run?: unknown;
  readonly uses?: unknown;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly "continue-on-error"?: unknown;
  readonly if?: unknown;
  readonly needs?: unknown;
  readonly permissions?: unknown;
  readonly steps?: unknown;
  readonly strategy?: { readonly matrix?: Readonly<Record<string, unknown>> };
  readonly "timeout-minutes"?: unknown;
  readonly uses?: unknown;
  readonly with?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

// A local action's own steps run what the workflows delegate to it, so they
// are held to the same pins and the same apt-get wrapper.
const localActions = await Array.fromAsync(
  new Bun.Glob("actions/*/action.yml").scan({ cwd: join(repositoryRoot, ".github"), dot: true }),
);

for (const workflow of [...workflows, ...localActions]) {
  // eslint-disable-next-line no-await-in-loop -- each workflow gets an exact diagnostic.
  const source = await Bun.file(join(repositoryRoot, ".github", workflow)).text();
  failures.push(...rawAptFailures(`.github/${workflow}`, Bun.YAML.parse(source)));
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
  readonly concurrency?: {
    readonly "cancel-in-progress"?: unknown;
    readonly group?: unknown;
    readonly queue?: unknown;
  };
  readonly on?: {
    readonly push?: { readonly tags?: unknown };
    readonly workflow_dispatch?: unknown;
  };
  readonly permissions?: unknown;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
};
const publishJobs = publishDocument.jobs ?? {};
const publishJob = publishJobs.publish;
const rawPublishSteps = publishJob?.steps;
const publishSteps: readonly WorkflowStep[] = Array.isArray(rawPublishSteps)
  ? (rawPublishSteps as WorkflowStep[])
  : [];
if (publishSteps.some((step) => step.if !== undefined || step["continue-on-error"] !== undefined)) {
  failures.push(".github/workflows/publish.yml: every publication step must run and fail closed");
}

const verifyJob = publishJobs.verify;
if (
  verifyJob?.uses !== "./.github/workflows/typescript.yml" ||
  verifyJob["continue-on-error"] !== undefined ||
  publishJob?.needs !== "verify" ||
  publishJob.if !== undefined ||
  publishJob["continue-on-error"] !== undefined
) {
  failures.push(
    ".github/workflows/publish.yml: publication must need the full reusable workflow and fail on any error",
  );
}
const rootPermissions = publishDocument.permissions;
const publishPermissions = publishJob?.permissions;
if (
  !isRecord(rootPermissions) ||
  Object.keys(rootPermissions).length !== 1 ||
  rootPermissions.contents !== "read" ||
  Object.entries(publishJobs).some(
    ([name, job]) => name !== "publish" && job.permissions !== undefined,
  ) ||
  !isRecord(publishPermissions) ||
  Object.keys(publishPermissions).length !== 2 ||
  publishPermissions.contents !== "read" ||
  publishPermissions["id-token"] !== "write"
) {
  failures.push(
    ".github/workflows/publish.yml: only the publication job may mint an npm OIDC token",
  );
}

const typescriptPath = join(repositoryRoot, ".github/workflows/typescript.yml");
const typescriptSource = await Bun.file(typescriptPath).text();
// GitHub reads a bare `off` as false, in the options and in the default. A default
// that is not one of the options refuses every dispatch that sets nothing.
for (const want of ['options: ["off", before-tests, on-failure]', 'default: "off"']) {
  if (!typescriptSource.includes(want)) {
    failures.push(`.github/workflows/typescript.yml: the tmate input must contain ${want}`);
  }
}
const typescriptDocument = Bun.YAML.parse(typescriptSource) as {
  readonly concurrency?: { readonly group?: unknown };
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
  readonly on?: Readonly<Record<string, unknown>>;
};
if (!Object.hasOwn(typescriptDocument.on ?? {}, "workflow_call")) {
  failures.push(
    ".github/workflows/typescript.yml: the full workflow must accept calls from the publish workflow",
  );
}
const typescriptJobs = typescriptDocument.jobs ?? {};

// A release proves every tmux lane. The publish workflow asks for the full
// scope by name, and a call that names none defaults to it, so neither can
// inherit the push-and-pull-request edges.
const callScope = (
  typescriptDocument.on?.workflow_call as
    | { readonly inputs?: { readonly scope?: { readonly default?: unknown } } }
    | undefined
)?.inputs?.scope?.default;
if (callScope !== "full" || verifyJob?.with?.scope !== "full") {
  failures.push(
    ".github/workflows/publish.yml: publication must call the reusable workflow with scope full, which is also its default",
  );
}

// The tmux lanes and the Bun versions come from the plan, which reads
// .github/ci-matrix.txt: a list written here would be a second one.
for (const [job, key, output] of [
  ["gates", "bun-version", "bun-versions"],
  ["tmux", "include", "tmux"],
] as const) {
  const taken = typescriptJobs[job]?.strategy?.matrix?.[key];
  if (taken !== `\${{ fromJSON(needs.plan.outputs.${output}) }}`) {
    failures.push(
      `.github/workflows/typescript.yml: ${job} must take its ${key} matrix from the plan's ${output}, not list versions itself`,
    );
  }
}

// A dispatch is a request for that run: its run id keeps one from cancelling
// another run of the same branch.
const typescriptGroup = typescriptDocument.concurrency?.group;
if (
  typeof typescriptGroup !== "string" ||
  !typescriptGroup.includes("workflow_dispatch") ||
  !typescriptGroup.includes("github.run_id")
) {
  failures.push(
    ".github/workflows/typescript.yml: a dispatch run must add github.run_id to the concurrency group",
  );
}

// One stable check stands for the workflow, so it has to wait for every job in
// it, or a job added later can fail without failing the check.
const requiredJob = typescriptJobs.required;
const otherJobs = Object.keys(typescriptJobs)
  .filter((name) => name !== "required")
  .toSorted();
const requiredNeeds = Array.isArray(requiredJob?.needs)
  ? requiredJob.needs.map(String).toSorted()
  : [];
if (
  requiredJob?.if !== "${{ always() }}" ||
  JSON.stringify(requiredNeeds) !== JSON.stringify(otherJobs)
) {
  failures.push(
    `.github/workflows/typescript.yml: required must run under always() and need every other job (${otherJobs.join(", ")}), not ${requiredNeeds.join(", ")}`,
  );
}

// A tmate session is a way into the runner. Only the tmux job may open one,
// pinned, limited to the account that dispatched the run, and under a timeout;
// no other workflow may.
for (const [name, job] of Object.entries(typescriptJobs)) {
  const steps = Array.isArray(job.steps) ? (job.steps as readonly WorkflowStep[]) : [];
  for (const step of steps) {
    if (typeof step.uses !== "string" || !step.uses.startsWith("mxschmitt/action-tmate@")) continue;
    if (name !== "tmux") {
      failures.push(
        `.github/workflows/typescript.yml: ${name} opens a tmate session; only tmux may`,
      );
    }
    if (step.with?.["limit-access-to-actor"] !== true) {
      failures.push(
        `.github/workflows/typescript.yml: the tmate step in ${name} must set limit-access-to-actor: true`,
      );
    }
    if (job["timeout-minutes"] === undefined) {
      failures.push(
        `.github/workflows/typescript.yml: ${name} opens tmate with no timeout-minutes`,
      );
    }
  }
}
for (const workflow of workflows) {
  if (workflow === "workflows/typescript.yml") continue;
  // eslint-disable-next-line no-await-in-loop -- each workflow gets an exact diagnostic.
  const source = await Bun.file(join(repositoryRoot, ".github", workflow)).text();
  if (source.includes("action-tmate")) {
    failures.push(`.github/${workflow}: must not open a tmate session`);
  }
}

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
const expectedPackageCheck = `for package in libtmux mcp workspace workspace-cli; do
  ( cd "packages/$package" && bun run test:package && bun run test:install )
done
`;
if (packageCheck !== expectedPackageCheck) {
  failures.push(
    ".github/workflows/publish.yml: must run test:install after test:package for libtmux, mcp, workspace, and workspace-cli",
  );
}

const publishTriggers = publishDocument.on ?? {};
const tagPatterns = publishTriggers.push?.tags;
if (
  Object.keys(publishTriggers).length !== 1 ||
  !Array.isArray(tagPatterns) ||
  tagPatterns.length !== 1 ||
  tagPatterns[0] !== "v*"
) {
  failures.push(
    ".github/workflows/publish.yml: the credentialed workflow must run only for v* tag pushes",
  );
}

const releaseCoordinator = publishSteps.find((step) => step.name === "Coordinate release")?.run;
if (releaseCoordinator !== "bun scripts/publish-release.ts") {
  failures.push(
    ".github/workflows/publish.yml: must delegate tag publishing to scripts/publish-release.ts",
  );
}

const publishConcurrency = publishDocument.concurrency;
if (
  publishConcurrency?.group !== "publish" ||
  publishConcurrency.queue !== "max" ||
  publishConcurrency["cancel-in-progress"] !== undefined
) {
  failures.push(
    ".github/workflows/publish.yml: must queue every release in the repository-wide publish concurrency group",
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
