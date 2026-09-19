import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bunFromPackageManager,
  checkBunVersionAgreement,
  extractVersionLiterals,
} from "./bun_version_pins.js";
import { slugify } from "../packages/libtmux/scripts/markdown_anchors.js";

/**
 * Hold the shell blocks and version claims in the docs to what the repository
 * actually contains.
 *
 * The ` ```ts ` blocks have been compiled since early on, but the ` ```console `
 * blocks beside them never were — and that is where the instructions live. The
 * root README told readers to clone the repository because npm had nothing on
 * it, and went on saying so through five published releases. Nothing was in a
 * position to notice.
 *
 * Ten claims are checked, all of them answerable from the tree:
 *
 * - a repository-relative path named in a shell block exists;
 * - a package named in an install command is one this workspace publishes;
 * - a public install example pins prerelease packages to the manifest version;
 * - a tmux badge lists exactly the versions CI runs the suite against;
 * - every published package README states the tested host-platform boundary;
 * - the Bun versions recorded in the CI matrix, the regex corpus, the
 *   `packageManager` pin, every manifest's `engines.bun` floor, and the
 *   CONTRIBUTING prose all agree;
 * - the two module counts CONTRIBUTING gives for `test:node`'s scope match
 *   the tree; and
 * - the README and CHANGELOG tables of contents list exactly the headings
 *   each file has, in order, with the anchor GitHub would mint for each; and
 * - the MCP tool count the root README gives matches the registry; and
 * - every `bench-*` script is named by the page that reports benchmarks.
 */

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const installers = new Map<string, number>([
  ["bun add", 2],
  ["bun install", 2],
  ["bunx", 1],
  ["npm i", 2],
  ["npm install", 2],
  ["npx", 1],
  ["pnpm add", 2],
  ["yarn add", 2],
]);

const failures: string[] = [];

const packageReadmes = [
  "README.md",
  "packages/libtmux/README.md",
  "packages/mcp/README.md",
  "packages/workspace/README.md",
] as const;

const platformClaims = [
  "Linux is the only supported host for real tmux control.",
  "The macOS CI lane checks package artifacts without exercising tmux; macOS runtime behavior is unproven.",
  "WSL is untested.",
] as const;

/** Every package this workspace publishes, read from the manifests. */
async function publishedPackages(): Promise<ReadonlyMap<string, string>> {
  const packages = new Map<string, string>();
  const listing = await Array.fromAsync(
    new Bun.Glob("packages/*/package.json").scan({ cwd: repositoryRoot }),
  );
  for (const manifest of listing) {
    // eslint-disable-next-line no-await-in-loop -- a handful of manifests, read in order.
    const parsed = (await Bun.file(join(repositoryRoot, manifest)).json()) as {
      name?: string;
      private?: boolean;
      version?: string;
    };
    if (parsed.name === undefined || parsed.private === true) continue;
    if (parsed.version === undefined) throw new Error(`${manifest} has no version`);
    packages.set(parsed.name, parsed.version);
  }
  return packages;
}

interface FencedBlock {
  readonly body: string;
  readonly line: number;
}

/** Fenced examples, including JSON client configuration that launches `npx`. */
function fencedBlocks(markdown: string): readonly FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = markdown.split("\n");
  let body: string[] | undefined;
  let line = 0;

  for (const [index, raw] of lines.entries()) {
    if (/^\s*```/u.test(raw)) {
      if (body === undefined) {
        body = [];
        line = index + 2;
      } else {
        blocks.push({ body: body.join("\n"), line });
        body = undefined;
      }
      continue;
    }
    body?.push(raw);
  }
  return blocks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageReferences(body: string, name: string): readonly RegExpMatchArray[] {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `(?<![a-z0-9@._/-])${escaped}(?:@[^\\s"'\\],}]+)?(?![a-z0-9._/-])`,
    "giu",
  );
  return [...body.matchAll(pattern)];
}

const installerInBlock =
  /(?:^|[\s"'`])(?:bun\s+add|npm\s+(?:i|install)|pnpm\s+add|yarn\s+add|bunx|npx)(?=$|[\s"'`])/mu;

function isPublicReadme(file: string): boolean {
  return file === "README.md" || file.endsWith("/README.md");
}

/** Shell lines from ` ```console ` blocks, with `\` continuations joined. */
function consoleCommands(markdown: string): readonly { command: string; line: number }[] {
  const commands: { command: string; line: number }[] = [];
  const lines = markdown.split("\n");
  let fence: string | undefined;
  let pending: { command: string; line: number } | undefined;

  for (const [index, raw] of lines.entries()) {
    const fenceMatch = /^\s*```(\w*)/u.exec(raw);
    if (fenceMatch) {
      fence = fence === undefined ? fenceMatch[1] : undefined;
      continue;
    }
    if (fence !== "console") continue;

    const line = raw.trimEnd();
    if (pending !== undefined) {
      pending.command += ` ${line.replace(/\\$/u, "").trim()}`;
      if (!line.endsWith("\\")) {
        commands.push(pending);
        pending = undefined;
      }
      continue;
    }
    if (!line.startsWith("$ ")) continue;
    const command = line.slice(2);
    if (command.endsWith("\\"))
      pending = { command: command.replace(/\\$/u, "").trim(), line: index + 1 };
    else commands.push({ command, line: index + 1 });
  }
  return commands;
}

const packages = await publishedPackages();

const listed = await new Bun.$.Shell()`git ls-files "*.md"`.cwd(repositoryRoot).text();
const files = listed
  .split("\n")
  .filter((line) => line !== "")
  // CLAUDE.md is AGENTS.md; reporting the same line twice under two names only
  // makes the reader wonder which of them to edit.
  .filter((file) => !lstatSync(join(repositoryRoot, file)).isSymbolicLink());

let checkedCommands = 0;
let checkedPrereleasePins = 0;

for (const file of files) {
  // eslint-disable-next-line no-await-in-loop -- one document at a time; failures are reported in file order.
  const markdown = await Bun.file(join(repositoryRoot, file)).text();

  for (const { command, line } of consoleCommands(markdown)) {
    checkedCommands += 1;
    const where = `${file}:${String(line)}`;
    const argv = command.split(/\s+/u).filter((token) => token !== "");

    for (const [prefix, skip] of installers) {
      if (!command.startsWith(`${prefix} `)) continue;
      for (const argument of argv.slice(skip)) {
        if (argument.startsWith("-")) continue;
        const name = argument.replace(/@[^@/]*$/u, "");
        if (!packages.has(name) && !packages.has(argument)) {
          failures.push(
            `${where}: \`${command}\` installs ${argument}, which this workspace does not publish`,
          );
        }
      }
      break;
    }

    // A repository-relative path in an instruction is the thing most likely to
    // rot: files move and the prose does not follow them.
    //
    // Only paths that reach into the tree are judged. One that escapes it
    // (`../libtmux`, the Python checkout) or names nothing at the root
    // (`./script.ts`, standing in for the reader's own file) is prose rather
    // than a reference.
    for (const argument of argv.slice(1)) {
      if (argument.startsWith("-") || argument.startsWith("/") || argument.startsWith("~"))
        continue;
      if (/^[a-z][a-z0-9+.-]*:/iu.test(argument) || !argument.includes("/")) continue;
      const path = argument.replace(/^\.\//u, "");
      const [head] = path.split("/");
      if (head === undefined || head === ".." || !existsSync(join(repositoryRoot, head))) continue;
      if (!existsSync(join(repositoryRoot, path))) {
        failures.push(`${where}: \`${command}\` names ${argument}, which does not exist`);
      }
    }
  }

  if (isPublicReadme(file)) {
    for (const block of fencedBlocks(markdown)) {
      if (!installerInBlock.test(block.body)) continue;
      for (const [name, version] of packages) {
        if (!version.includes("-")) continue;
        for (const match of packageReferences(block.body, name)) {
          checkedPrereleasePins += 1;
          if (match[0] === `${name}@${version}`) continue;
          const prefix = block.body.slice(0, match.index).split("\n").length - 1;
          failures.push(
            `${file}:${String(block.line + prefix)}: public install example uses ${match[0]}; pin ${name}@${version}`,
          );
        }
      }
    }
  }
}

for (const file of packageReadmes) {
  // eslint-disable-next-line no-await-in-loop -- four public contracts, reported in package order.
  const markdown = await Bun.file(join(repositoryRoot, file)).text();
  const prose = markdown.replace(/\s+/gu, " ");
  for (const claim of platformClaims) {
    if (!prose.includes(claim)) failures.push(`${file}: missing platform claim: ${claim}`);
  }
}

/**
 * The two long documents this repository ships get a table of contents,
 * checked against the headings each file actually has rather than hand-kept.
 * The README's previous, hand-grouped index had already drifted — it silently
 * dropped five headings a themed grouping missed — which is the failure mode
 * a mechanical listing cannot reproduce.
 *
 * `depth` is the deepest heading level the table of contents lists. It is
 * fixed per file rather than inferred from the block: inferring it from
 * whatever the table currently lists would let a whole level of entries be
 * deleted without this noticing.
 */
const tablesOfContents = [
  { depth: 3, file: "packages/libtmux/README.md" },
  { depth: 2, file: "packages/libtmux/CHANGELOG.md" },
] as const;

interface DocHeading {
  readonly level: number;
  readonly line: number;
  readonly text: string;
}

/** Headings at level 2 up to `maxLevel`, skipping fenced code so a `#` in a shell block cannot count. */
function headingsUpTo(markdown: string, maxLevel: number): readonly DocHeading[] {
  const headings: DocHeading[] = [];
  let fenced = false;
  for (const [index, line] of markdown.split("\n").entries()) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (match?.[1] === undefined) continue;
    if (match[1].length < 2 || match[1].length > maxLevel) continue;
    headings.push({ level: match[1].length, line: index + 1, text: match[2] ?? "" });
  }
  return headings;
}

/** The anchor GitHub mints for each heading, de-duplicating repeats with `-1`, `-2`, ... */
function githubAnchors(headings: readonly DocHeading[]): readonly string[] {
  const seen = new Map<string, number>();
  return headings.map(({ text }) => {
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${String(count)}`;
  });
}

interface TocEntry {
  readonly anchor: string;
  readonly level: number;
  readonly line: number;
  readonly text: string;
}

/** The `- [text](#anchor)` lines between the `<!-- toc -->` markers this gate owns. */
function tocEntries(markdown: string): readonly TocEntry[] | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === "<!-- toc -->");
  const end = lines.findIndex((line) => line.trim() === "<!-- /toc -->");
  if (start === -1 || end === -1 || end <= start) return undefined;

  const entries: TocEntry[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    const match = /^(\s*)- \[(.+)\]\(#(.+)\)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    entries.push({
      anchor: match[3],
      level: 2 + match[1].length / 2,
      line: index + 1,
      text: match[2],
    });
  }
  return entries;
}

let tocEntriesChecked = 0;

for (const { depth, file } of tablesOfContents) {
  // eslint-disable-next-line no-await-in-loop -- two documents, reported in list order.
  const markdown = await Bun.file(join(repositoryRoot, file)).text();
  const entries = tocEntries(markdown);
  if (entries === undefined) {
    failures.push(`${file}: has no <!-- toc --> ... <!-- /toc --> block to check`);
    continue;
  }

  const headings = headingsUpTo(markdown, depth);
  const anchors = githubAnchors(headings);

  if (entries.length !== headings.length) {
    failures.push(
      `${file}: table of contents lists ${String(entries.length)} headings; the file has ${String(headings.length)} up to level ${String(depth)}`,
    );
    continue;
  }

  for (const [index, entry] of entries.entries()) {
    const heading = headings[index];
    const anchor = anchors[index];
    if (heading === undefined || anchor === undefined) continue;
    tocEntriesChecked += 1;
    if (entry.level !== heading.level || entry.text !== heading.text || entry.anchor !== anchor) {
      failures.push(
        `${file}:${String(entry.line)}: table of contents entry ${String(index + 1)} is "${entry.text}" (#${entry.anchor}, level ${String(entry.level)}); heading ${String(index + 1)} is "${heading.text}" (#${anchor}, level ${String(heading.level)})`,
      );
    }
  }
}

// The tmux badge is the one version claim a reader takes at face value, so it
// is pinned to the matrix that proves it rather than to someone's memory.
const workflow = await Bun.file(join(repositoryRoot, ".github/workflows/typescript.yml")).text();
const matrix = /tmux-version:\s*\[([^\]]+)\]/u.exec(workflow)?.[1];
if (matrix === undefined) throw new Error("could not read the tmux matrix from typescript.yml");
const tested = matrix.split(",").map((entry) => entry.trim().replaceAll('"', ""));

// The badge names the range's ends rather than every release in it: eight
// entries is a badge nobody reads, and the ends are the claim — everything
// between them is in the matrix above, which is what this compares against.
// A badge tells a reader which releases are covered, and `master` is not one
// they can install — it is a moving branch the matrix tracks so the version
// ranking has a real `next-X.Y` binary behind it. The ends of the badge are
// the tagged ends.
const releases = tested.filter((version) => version !== "master");
const range = `${releases[0] ?? ""}\u2013${releases.at(-1) ?? ""}`;

let badges = 0;
for (const file of files) {
  // eslint-disable-next-line no-await-in-loop -- one document at a time, as above.
  const markdown = await Bun.file(join(repositoryRoot, file)).text();
  for (const match of markdown.matchAll(/img\.shields\.io\/badge\/tmux-((?:--|[^-])+)-(?!-)/gu)) {
    badges += 1;
    // shields.io escapes a literal hyphen in a field as `--`, so a version
    // like `3.8-rc` cannot be read without undoing that first — the badge
    // said 3.8 and the matrix said 3.8-rc, and only the escape differed.
    const claimed = decodeURIComponent(match[1] ?? "")
      .replaceAll("--", "-")
      .trim();
    if (claimed !== range) {
      failures.push(`${file}: the tmux badge claims ${claimed} but CI runs ${range}`);
    }
  }
}

// The Bun version is recorded in the gates matrix, the regex corpus, the
// packageManager pin, every manifest's engines.bun floor, and the
// CONTRIBUTING prose that describes them — nowhere else compares all five.
const bunMatrixClaim = /bun-version:\s*\[([^\]]+)\]/u.exec(workflow)?.[1];
if (bunMatrixClaim === undefined) {
  throw new Error("could not read the gates job's bun-version matrix from typescript.yml");
}
const bunMatrix = bunMatrixClaim.split(",").map((entry) => entry.trim().replaceAll('"', ""));

const regexCorpusPath = "packages/libtmux/tests/fixtures/where_regex.json";
const regexCorpus = (await Bun.file(join(repositoryRoot, regexCorpusPath)).json()) as {
  readonly runtimes?: { readonly bun?: unknown };
};
const corpusBun = Array.isArray(regexCorpus.runtimes?.bun)
  ? regexCorpus.runtimes.bun.map(String)
  : [];

const rootManifest = (await Bun.file(join(repositoryRoot, "package.json")).json()) as {
  readonly packageManager?: unknown;
};
const packageManagerBun = bunFromPackageManager(
  typeof rootManifest.packageManager === "string" ? rootManifest.packageManager : "",
);
if (packageManagerBun === undefined) {
  failures.push(
    `package.json: packageManager is ${JSON.stringify(rootManifest.packageManager)}, not a pinned bun@<version>`,
  );
}

const contributingPath = ".github/CONTRIBUTING.md";
const contributingText = await Bun.file(join(repositoryRoot, contributingPath)).text();
const pinParagraph = contributingText
  .split(/\n{2,}/u)
  .find((paragraph) => paragraph.includes("`packageManager` pin"));
if (pinParagraph === undefined) {
  failures.push(
    `${contributingPath}: has no paragraph naming the packageManager pin to check the Bun matrix against`,
  );
}

/**
 * Anything whose behaviour belongs to the runtime rather than to this package.
 *
 * Type-only mentions are stripped before this is applied: a module that names
 * `AbortSignal` in a signature and never evaluates one runs identically on
 * either runtime, and counting it would overstate what `test:node` has to
 * cover. The `node:` alternative is anchored to a quoted module specifier for
 * the same reason: a bare word-boundary match also matches a parameter named
 * `node` before its type annotation, which counted a query-validation module
 * whose every import is one of this package's own.
 */
const runtimeApi =
  /["']node:[a-z0-9_/.-]+["']|\bAbortController\b|\bAbortSignal\b|\bTextDecoder\b|\bTextEncoder\b|\bBuffer\b|\bperformance\.now\b|\bset(?:Timeout|Interval|Immediate)\b|\bclear(?:Timeout|Interval)\b|\bprocess\./u;

function shippedModuleCounts(): { readonly runtime: number; readonly total: number } {
  const root = join(repositoryRoot, "packages/libtmux");
  const modules = Array.from(new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })).filter(
    (file) =>
      !file.includes("_generated/") &&
      !file.includes("_internal/test/") &&
      !file.endsWith(".test.ts"),
  );
  let runtime = 0;
  for (const file of modules) {
    const code = readFileSync(join(root, file), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .split("\n")
      .filter(
        (line) => !/^\s*(?:\/\/|\*)/u.test(line) && !/^\s*(?:import|export)\s+type\b/u.test(line),
      )
      .join("\n");
    if (runtimeApi.test(code)) runtime += 1;
  }
  return { runtime, total: modules.length };
}

// The counts are the whole argument for `test:node` running scenarios rather
// than the suite, and they drift every time a module is added. Stated and
// never checked, they were wrong: the prose said 22 when the tree held 24.
const moduleCounts = shippedModuleCounts();
const claimedCounts = /(\d+) of the (\d+) shipped modules/u.exec(contributingText);
if (claimedCounts === null) {
  failures.push(`${contributingPath}: has no "<n> of the <total> shipped modules" claim to check`);
} else if (
  Number(claimedCounts[1]) !== moduleCounts.runtime ||
  Number(claimedCounts[2]) !== moduleCounts.total
) {
  failures.push(
    `${contributingPath}: claims ${String(claimedCounts[1])} of ${String(claimedCounts[2])} shipped modules touch a runtime API; the tree has ${String(moduleCounts.runtime)} of ${String(moduleCounts.total)}`,
  );
} else if (!contributingText.includes(`one of those ${String(moduleCounts.runtime)}`)) {
  failures.push(
    `${contributingPath}: the scenario rule does not refer back to the same ${String(moduleCounts.runtime)} modules`,
  );
}

/**
 * The MCP tool count the root README gives a reader.
 *
 * Three suites in `packages/mcp` already pin the registry at 45, so the code
 * cannot drift silently — but the README's copy of the number is prose beside
 * them, and prose is what goes stale. Counted from the registrations
 * themselves so the two cannot disagree.
 */
function registeredMcpTools(): number {
  const root = join(repositoryRoot, "packages/mcp/src/tools");
  const names = new Set<string>();
  for (const file of new Bun.Glob("*.ts").scanSync({ cwd: root })) {
    // The name may sit on the line after the call opens, so this spans lines.
    for (const match of readFileSync(join(root, file), "utf8").matchAll(
      /registerTool\(\s*"([a-z_]+)"/gu,
    )) {
      names.add(match[1] ?? "");
    }
  }
  return names.size;
}

const mcpTools = registeredMcpTools();
const claimedTools = /The (\d+) tools are split into/u.exec(
  await Bun.file(join(repositoryRoot, "README.md")).text(),
);
if (claimedTools === null) {
  failures.push('README.md: has no "The <n> tools are split into" claim to check');
} else if (Number(claimedTools[1]) !== mcpTools) {
  failures.push(
    `README.md: claims ${String(claimedTools[1])} MCP tools; packages/mcp registers ${String(mcpTools)}`,
  );
}

/**
 * Every benchmark script is named by the page that reports benchmarks.
 *
 * `bench-control.ts` existed, had a unit test, and appeared nowhere in
 * `docs/benchmarks.md` — so the workload that measures backpressure and
 * reconnection was invisible from the page a reader goes to for exactly that.
 * Nothing would have said so.
 */
const benchmarksPath = "packages/libtmux/docs/benchmarks.md";
const benchmarksPage = await Bun.file(join(repositoryRoot, benchmarksPath)).text();
const benchScripts = Array.from(
  new Bun.Glob("bench-*.ts").scanSync({ cwd: join(repositoryRoot, "packages/libtmux/scripts") }),
).toSorted((left, right) => left.localeCompare(right));
for (const script of benchScripts) {
  if (!benchmarksPage.includes(script)) {
    failures.push(`${benchmarksPath}: does not name packages/libtmux/scripts/${script}`);
  }
}

const engineManifests = [
  "package.json",
  "packages/libtmux/package.json",
  "packages/mcp/package.json",
  "packages/workspace/package.json",
] as const;
const engines = await Promise.all(
  engineManifests.map(async (path) => {
    const manifest = (await Bun.file(join(repositoryRoot, path)).json()) as {
      readonly engines?: { readonly bun?: unknown };
    };
    const bun = manifest.engines?.bun;
    return { path, spec: typeof bun === "string" ? bun : "" };
  }),
);

if (packageManagerBun !== undefined && pinParagraph !== undefined) {
  failures.push(
    ...checkBunVersionAgreement({
      contributingPin: extractVersionLiterals(pinParagraph),
      corpus: corpusBun,
      engines,
      matrix: bunMatrix,
      packageManager: packageManagerBun,
    }),
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `Documentation claims the repository does not support:\n${failures
      .map((failure) => `  ${failure}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  `Documentation claims hold: ${String(checkedCommands)} shell commands, ${String(checkedPrereleasePins)} prerelease pins, ${String(badges)} tmux badges against CI's ${tested.join(", ")}, Bun ${bunMatrix.join(", ")} agreed across the matrix, corpus, packageManager, engines, and CONTRIBUTING, ${String(moduleCounts.runtime)} of ${String(moduleCounts.total)} shipped modules touching a runtime API, ${String(tocEntriesChecked)} table-of-contents entries across ${String(tablesOfContents.length)} files, ${String(mcpTools)} MCP tools, and ${String(benchScripts.length)} benchmark scripts\n`,
);
