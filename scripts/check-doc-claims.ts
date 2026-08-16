import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * Three claims are checked, all of them answerable from the tree:
 *
 * - a repository-relative path named in a shell block exists;
 * - a package named in an install command is one this workspace publishes;
 * - a tmux badge lists exactly the versions CI runs the suite against.
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

/** Every package name this workspace publishes, read from the manifests. */
async function publishedPackages(): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const listing = await Array.fromAsync(
    new Bun.Glob("packages/*/package.json").scan({ cwd: repositoryRoot }),
  );
  for (const manifest of listing) {
    // eslint-disable-next-line no-await-in-loop -- a handful of manifests, read in order.
    const parsed = (await Bun.file(join(repositoryRoot, manifest)).json()) as {
      name?: string;
      private?: boolean;
    };
    if (parsed.name !== undefined && parsed.private !== true) names.add(parsed.name);
  }
  return names;
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
const range = `${tested[0] ?? ""}\u2013${tested.at(-1) ?? ""}`;

let badges = 0;
for (const file of files) {
  // eslint-disable-next-line no-await-in-loop -- one document at a time, as above.
  const markdown = await Bun.file(join(repositoryRoot, file)).text();
  for (const match of markdown.matchAll(/img\.shields\.io\/badge\/tmux-([^-]+)-/gu)) {
    badges += 1;
    const claimed = decodeURIComponent(match[1] ?? "").trim();
    if (claimed !== range) {
      failures.push(`${file}: the tmux badge claims ${claimed} but CI runs ${range}`);
    }
  }
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
  `Documentation claims hold: ${String(checkedCommands)} shell commands, ${String(badges)} tmux badges against CI's ${tested.join(", ")}\n`,
);
