import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { makeTestDirectory, resolveNode22 } from "../../src/_internal/test/testkit.js";
import { parseCalls, RECORDING_TMUX } from "../support/recording_tmux.js";

/**
 * Shows the canary can fail, and that each bunfig.toml is what makes it pass. Each case runs it
 * with decoys of the four variables; a real tmux starts only inside a sandbox, never at a decoy.
 */

const repository = fileURLToPath(new URL("../../../..", import.meta.url));
const canary = join(repository, "packages/libtmux/tests/unit/sandbox_canary.test.ts");
const suite = join(repository, "packages/libtmux/tests/integration/acquire.test.ts");

// Every example is a package whose own directory a `bun test` can start in.
const EXAMPLES = readdirSync(join(repository, "examples"), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(join(repository, "examples", entry.name, "package.json")),
  )
  .map((entry) => join("examples", entry.name));

const STARTING_POINTS: string[] = [
  "",
  "packages/libtmux",
  "packages/mcp",
  "packages/workspace",
  "packages/workspace-cli",
  "examples",
  ...EXAMPLES,
];

let decoys = "";

beforeAll(async () => {
  decoys = await makeTestDirectory("ltx-decoys-");
});

afterAll(async () => {
  await rm(decoys, { force: true, recursive: true });
});

/** The variables a developer's shell inside tmux holds, none of them naming a real socket. */
function decoyEnvironment(path: string): Record<string, string> {
  return {
    HOME: process.env["HOME"] ?? decoys,
    LIBTMUX_SOCKET: "decoy",
    LIBTMUX_SOCKET_PATH: join(decoys, "decoy.sock"),
    PATH: path,
    TMPDIR: tmpdir(),
    TMUX: `${join(decoys, "decoy.sock")},1,0`,
    TMUX_PANE: "%9",
    TMUX_TMPDIR: decoys,
  };
}

async function runCommand(
  command: string[],
  cwd: string,
  path = process.env["PATH"] ?? "",
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env: decoyEnvironment(path),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

const runBunTest = async (cwd: string, file: string, path?: string) =>
  runCommand([process.execPath, "test", file], cwd, path);

const runCanary = async (cwd: string) => runBunTest(cwd, canary);

describe("sandbox canary controls", () => {
  test.each(STARTING_POINTS)(
    "passes from %j, where bunfig.toml enters the sandbox",
    async (directory) => {
      const { exitCode, output } = await runCanary(join(repository, directory));
      expect(output).toContain("5 pass");
      expect(exitCode).toBe(0);
    },
    60_000,
  );

  test("fails every case where no bunfig.toml does", async () => {
    const { exitCode, output } = await runCanary(decoys);

    expect(exitCode).not.toBe(0);
    expect(output).toContain("refusing to run outside the tmux sandbox: TMUX is set");
    expect(output).toContain(
      "(fail) sandbox canary > no variable that names another server survives",
    );
    expect(output).toContain(
      "(fail) sandbox canary > the process is in an owner-only sandbox that TMUX_TMPDIR names",
    );
    expect(output).toContain(
      "(fail) sandbox canary > a server built with no socket reaches the default socket inside the sandbox",
    );
    expect(output).toContain(
      "(fail) sandbox canary > a real bare tmux client starts its server on the default socket inside the sandbox",
    );
    expect(output).toContain(
      "(fail) sandbox canary > the same client lands elsewhere when TMUX_TMPDIR is not the sandbox",
    );
  }, 60_000);

  test("a real-tmux suite started where no bunfig.toml enters the sandbox refuses its fixtures", async () => {
    const bin = join(decoys, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "tmux"), RECORDING_TMUX);
    await chmod(join(bin, "tmux"), 0o755);

    const { exitCode, output } = await runBunTest(
      decoys,
      suite,
      `${bin}:${process.env["PATH"] ?? ""}`,
    );
    const trace = existsSync(join(bin, "trace")) ? await readFile(join(bin, "trace"), "utf8") : "";

    expect(exitCode).not.toBe(0);
    expect(output).toContain("refusing to run outside the tmux sandbox: TMUX is set");
    // The suite's other cases name their own sockets, which no TMUX overrides.
    const unpinned = parseCalls(trace).filter(
      (call) =>
        call.set.includes("TMUX") && !call.argv.some((argument) => /^-[LS]/u.test(argument)),
    );
    expect(unpinned).toEqual([]);
  }, 60_000);

  test("a rerun round enters a sandbox of its own", async () => {
    const { exitCode, output } = await runCommand(
      [process.execPath, "test", "--rerun-each", "3", canary],
      join(repository, "packages/libtmux"),
    );

    expect(output).toContain("15 pass");
    expect(exitCode).toBe(0);
  }, 120_000);

  test("the Node lane's config names the same setup file the bunfig.toml preloads", async () => {
    const { default: config } = await import("../../vitest.node.config.js");
    const bunfig = await readFile(join(repository, "packages/libtmux/bunfig.toml"), "utf8");

    const preload = /preload = \["([^"]+)"\]/u.exec(bunfig)?.[1] ?? "";

    expect(preload).not.toBe("");
    expect(config.test?.setupFiles).toEqual([preload]);
  });

  // Node's lane runs under vitest, which reads no bunfig.toml: its setup file is all there is.
  describe.each([
    ["names the setup file", true],
    ["names none", false],
  ])("vitest started directly with a config that %s", (_name, withSetup) => {
    test(
      withSetup
        ? "enters the sandbox, so the canary passes"
        : "leaves the process out, so the canary fails",
      async () => {
        const packageRoot = join(repository, "packages/libtmux");
        const config = join(decoys, `vitest-${withSetup ? "with" : "without"}.config.mjs`);
        await writeFile(
          config,
          `export default ${JSON.stringify({
            resolve: {
              alias: [
                {
                  find: "bun:test",
                  replacement: join(packageRoot, "tests/support/bun_test_on_node.ts"),
                },
              ],
            },
            test: {
              include: ["tests/unit/sandbox_canary.test.ts"],
              pool: "forks",
              ...(withSetup
                ? { setupFiles: [join(packageRoot, "tests/support/sandbox_preload.ts")] }
                : {}),
            },
          })};\n`,
        );

        const { exitCode, output } = await runCommand(
          [
            await resolveNode22(),
            join(packageRoot, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            config,
            "--root",
            packageRoot,
          ],
          decoys,
        );

        if (withSetup) {
          expect(exitCode).toBe(0);
          expect(output).toContain("5 passed");
        } else {
          expect(exitCode).not.toBe(0);
          expect(output).toContain("TMUX is set");
        }
      },
      120_000,
    );
  });
});
