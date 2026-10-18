/* eslint-disable no-await-in-loop -- Each README command runs after the one before it, against one private tmux directory. */
import { expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedCommand } from "../../../scripts/bounded_process.js";
import { fences, steps, words } from "../../../scripts/readme_blocks.js";
import { makeTestDirectory, runWithCleanup } from "../../libtmux/src/_internal/test/testkit.js";
import manifest from "../package.json" with { type: "json" };

/**
 * Run the `tmux-workspace` commands the READMEs print.
 *
 * A command a reader copies is a claim about flags, file names and exit codes,
 * and `docs:claims` only checks that the package it names exists. These run
 * verbatim against a tmux directory of their own: `-L workspace-cli-demo`
 * means what it says, because `TMUX_TMPDIR` points at a directory this test
 * made and removes. `tmux-workspace` and `npx -y @libtmux/workspace-cli@<v>`
 * both resolve to this working tree, and the `npx` form refuses any version
 * but the manifest's, so a stale pin fails here as it would for a reader.
 *
 * A fence that follows a line of the form "Save this document as `name`:"
 * becomes the file of that name before the commands run.
 */

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const documents = [
  "README.md",
  "packages/libtmux/README.md",
  "packages/workspace/README.md",
  "packages/workspace-cli/README.md",
] as const;
const PACKAGE = "@libtmux/workspace-cli";

interface World {
  readonly cwd: string;
  readonly directory: string;
  readonly environment: Record<string, string>;
  readonly tmuxDirectory: string;
}

/** Whether a README command is one of ours to run, rather than a package manager's. */
function runnable(command: string): boolean {
  const found = words(command);
  // A pipe hands the output to a shell builtin such as fish's `source`, which
  // `sh` does not have.
  if (found.includes("|")) return false;
  if (found[0] === "tmux-workspace") return true;
  return found[0] === "npx" && found.some((word) => word.startsWith(`${PACKAGE}@`));
}

async function inWorld<T>(body: (world: World) => Promise<T>): Promise<T> {
  const directory = await makeTestDirectory("ltx-wcli-readme-");
  const bin = join(directory, "bin");
  const cwd = join(directory, "work");
  const tmuxDirectory = join(directory, "t");
  await Promise.all([bin, cwd, tmuxDirectory, join(directory, "home")].map((path) => mkdir(path)));
  await writeFile(
    join(bin, "tmux-workspace"),
    `#!/bin/sh\nexec '${process.execPath}' '${entry}' "$@"\n`,
  );
  await writeFile(
    join(bin, "npx"),
    [
      "#!/bin/sh",
      `if [ "$1" != "-y" ] || [ "$2" != "${PACKAGE}@${manifest.version}" ]; then`,
      `  echo "npx: expected -y ${PACKAGE}@${manifest.version}, got: $*" >&2`,
      "  exit 97",
      "fi",
      "shift 2",
      'exec tmux-workspace "$@"',
      "",
    ].join("\n"),
  );
  await Promise.all(["tmux-workspace", "npx"].map((name) => chmod(join(bin, name), 0o755)));
  const environment: Record<string, string> = {
    HOME: join(directory, "home"),
    LANG: process.env["LANG"] ?? "C.UTF-8",
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    TMUX_TMPDIR: tmuxDirectory,
    XDG_CONFIG_HOME: join(directory, "home", ".config"),
  };
  return runWithCleanup(
    () => body({ cwd, directory, environment, tmuxDirectory }),
    async () => {
      // The daemons `load -d` leaves behind outlive the command that started
      // them, so removing the directory would orphan every one.
      const sockets = join(tmuxDirectory, `tmux-${String(process.getuid?.() ?? 0)}`);
      for (const name of await readdir(sockets).catch(() => [])) {
        await runBoundedCommand(["tmux", "-S", join(sockets, name), "kill-server"], {
          env: environment,
          maxOutputBytes: 65_536,
          timeoutMilliseconds: 10_000,
        });
      }
      await rm(directory, { force: true, recursive: true });
    },
  );
}

async function execute(world: World, command: string) {
  return runBoundedCommand(["sh", "-c", command], {
    cwd: world.cwd,
    env: world.environment,
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMilliseconds: 30_000,
  });
}

async function sessionsOn(world: World, selector: readonly string[]): Promise<readonly string[]> {
  const listed = await runBoundedCommand(
    ["tmux", ...selector, "list-sessions", "-F", "#{session_name}"],
    { env: world.environment, maxOutputBytes: 65_536, timeoutMilliseconds: 10_000 },
  );
  return listed.stdout.split("\n").filter((name) => name !== "");
}

/** The value after a flag, or undefined. */
function flagValue(found: readonly string[], flag: string): string | undefined {
  const index = found.indexOf(flag);
  return index === -1 ? undefined : found[index + 1];
}

/** What the README says a command did, held against what it did. */
async function assertOutcome(world: World, command: string, stdout: string): Promise<void> {
  const found = words(command);
  const subcommand = found.find((word, index) => {
    const previous = found[index - 1];
    return (
      ["load", "freeze", "convert", "import"].includes(word) &&
      (previous === "tmux-workspace" || previous?.startsWith(`${PACKAGE}@`) === true)
    );
  });
  const socket = flagValue(found, "-L");
  const socketPath = flagValue(found, "-S");
  const selector = socket !== undefined ? ["-L", socket] : socketPath ? ["-S", socketPath] : [];

  if (subcommand === "load" && found.includes("-d") && selector.length > 0) {
    const source = found.find((word) => /\.(?:ya?ml|json)$/u.test(word));
    expect(source, command).toBeDefined();
    const text = await readFile(join(world.cwd, source ?? ""), "utf8");
    const document = (source?.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text)) as {
      session_name: string;
    };
    expect(await sessionsOn(world, selector), command).toContain(
      flagValue(found, "-s") ?? document.session_name,
    );
  }
  if (subcommand === "freeze" && found.includes("--json")) {
    const session = found[found.indexOf("freeze") + 1] ?? "";
    expect((JSON.parse(stdout) as { session_name: string }).session_name, command).toBe(session);
  }
  const destination = flagValue(found, "--save-to");
  if ((subcommand === "convert" || subcommand === "import") && destination !== undefined) {
    const saved = await readFile(join(world.cwd, destination), "utf8");
    const parsed = (
      flagValue(found, "--workspace-format") === "json" ? JSON.parse(saved) : Bun.YAML.parse(saved)
    ) as { session_name?: string; windows?: unknown };
    expect(parsed.session_name, command).toBeString();
    expect(parsed.windows, command).toBeArray();
  }
  if (found.includes("--json") && destination === undefined && subcommand !== undefined) {
    expect(() => JSON.parse(stdout) as unknown, command).not.toThrow();
  }
}

async function saveFixtures(world: World, markdown: string, file: string): Promise<number> {
  let saved = 0;
  for (const fence of fences(markdown, file)) {
    const name = /\bas `(?<name>[^`/]+)`/u.exec(fence.lead)?.groups?.["name"];
    if (name === undefined || !["yaml", "yml", "json"].includes(fence.language)) continue;
    await writeFile(join(world.cwd, name), `${fence.lines.join("\n")}\n`);
    saved += 1;
  }
  return saved;
}

function commandsIn(markdown: string, file: string): readonly { command: string; line: number }[] {
  return fences(markdown, file)
    .filter((fence) => fence.language === "console")
    .flatMap((fence) => steps(fence))
    .filter(({ command }) => runnable(command));
}

for (const file of documents) {
  test(`${file} commands run as printed`, async () => {
    const markdown = await readFile(join(repositoryRoot, file), "utf8");
    const commands = commandsIn(markdown, file);
    // A document that stops showing commands would otherwise pass by running
    // nothing, which is what a broken extraction looks like too.
    expect(commands.length, `${file} shows no tmux-workspace command`).toBeGreaterThan(0);
    await inWorld(async (world) => {
      await saveFixtures(world, markdown, file);
      for (const { command, line } of commands) {
        const result = await execute(world, command);
        expect(
          result,
          `${file}:${String(line)} ${command}\n${result.stdout}${result.stderr}`,
        ).toMatchObject({ exitCode: 0, termination: "exited" });
        await assertOutcome(world, command, result.stdout);
      }
    });
  }, 120_000);
}

test("a command that would fail for a reader fails here", async () => {
  await inWorld(async (world) => {
    await saveFixtures(
      world,
      "Save this document as `workspace.yaml`:\n\n```yaml\nsession_name: dev\nwindows:\n  - panes: [vim]\n```\n",
      "control",
    );
    const good = "tmux-workspace load ./workspace.yaml -L control -d --json";
    const control = await execute(world, good);
    expect(control, control.stderr).toMatchObject({ exitCode: 0, termination: "exited" });
    await assertOutcome(world, good, control.stdout);

    const unknownFlag = await execute(world, `${good} --no-such-flag`);
    expect(unknownFlag.exitCode).not.toBe(0);
    const missingFile = await execute(world, "tmux-workspace load ./missing.yaml -L control -d");
    expect(missingFile.exitCode).not.toBe(0);
    const stalePin = await execute(world, `npx -y ${PACKAGE}@0.0.0-stale --help`);
    expect(stalePin.exitCode).toBe(97);
    const currentPin = await execute(world, `npx -y ${PACKAGE}@${manifest.version} --version`);
    expect(currentPin.stdout).toBe(`tmux-workspace ${manifest.version}\n`);

    // The outcome check bites too: a session the document never named is not
    // what loading it produces.
    await expect(
      assertOutcome(world, "tmux-workspace load ./workspace.yaml -L control -d -s absent", ""),
    ).rejects.toThrow();
  });
}, 120_000);
