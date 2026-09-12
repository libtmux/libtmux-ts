/* eslint-disable no-await-in-loop -- Installed CLI cases share a private server and run sequentially. */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { npmPack } from "../../../scripts/npm_pack.js";
import { runBoundedCommand } from "../../../scripts/bounded_process.js";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
  resolveNode22,
  runWithCleanup,
  TestServer,
  withOwnedRunRoot,
} from "../../libtmux/src/_internal/test/testkit.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../libtmux", import.meta.url));
const node = await resolveNode22();
const python = process.env.TMUX_WORKSPACE_PYTHON || "python3";
const project = await makeTestDirectory("ltx-cli-install-");
const tmux = process.env.LIBTMUX_TEST_TMUX ?? "tmux";
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

async function execute(argv: string[], env: NodeJS.ProcessEnv, timeoutMilliseconds = 30_000) {
  const result = await runBoundedCommand(argv, {
    cwd: project,
    env,
    timeoutMilliseconds,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  assert.equal(result.termination, "exited", `${argv[1]}: ${result.termination}`);
  assert.equal(result.exitCode, 0, `${argv.slice(1).join(" ")}\n${result.stderr}`);
  return result;
}

await runWithCleanup(
  async () => {
    const artifacts = join(project, "artifacts");
    const core = await npmPack(coreRoot, artifacts);
    const cli = await npmPack(packageRoot, artifacts);
    assert(cli.entries.includes("dist/main.js"));
    assert(
      !cli.entries.some((path) => path.startsWith("node_modules/") || path.startsWith("tests/")),
    );
    await writeFile(join(project, "package.json"), '{"private":true,"type":"module"}\n');
    await execute(
      [
        "npm",
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        core.tarballPath,
        cli.tarballPath,
      ],
      process.env,
      120_000,
    );
    const executable = join(project, "node_modules/.bin/tmux-workspace");
    assert((await realpath(executable)).startsWith(join(project, "node_modules/")));
    const userBase = (
      await execute([python, "-c", "import site; print(site.USER_BASE)"], process.env)
    ).stdout.trim();
    await mkdir(join(project, ".tmuxp"));
    await writeFile(join(project, "editor.cjs"), "process.stdout.write(process.argv.at(-1));\n");
    await writeFile(join(project, "before.cjs"), "console.log('bootstrap\\tΔ\\x1b[31m');\n");
    await writeFile(
      join(project, "teamocil.yaml"),
      "name: imported\nwindows:\n  - name: editor\n    panes:\n      - cmd: echo ready\n",
    );
    await writeFile(
      join(project, "tmuxinator.yaml"),
      "name: imported\nwindows:\n  - editor: echo ready\n",
    );
    await withOwnedRunRoot(
      "ltx-cli-install-run-",
      async (runRoot) => {
        const fixture = await TestServer.create({
          runRoot,
          sessionName: "fixture",
          tmuxExecutable: tmux,
        });
        assertOwnedSocketPath(fixture.socketPath);
        await runWithCleanup(
          async () => {
            const env = {
              ...fixture.controllerEnvironment,
              HOME: project,
              XDG_CONFIG_HOME: join(project, ".config"),
              TMUXP_CONFIGDIR: join(project, ".tmuxp"),
              TMUX: "",
              TMUX_PANE: "",
              TMUX_BIN: fixture.tmuxExecutable,
              PYTHONUSERBASE: userBase,
              EDITOR: `${quote(node)} ${quote(join(project, "editor.cjs"))}`,
              FORCE_COLOR: "1",
              NO_COLOR: "",
            };
            let checked = 0;
            for (const [label, runtime] of [
              ["node22", node],
              ["bun", process.execPath],
            ] as const) {
              for (const mode of ["json", "ndjson"] as const) {
                const session = `package-${label}-${mode}`;
                const marker = join(project, `${session}.ready`);
                const workspace = join(project, ".tmuxp", `${session}.json`);
                await writeFile(
                  workspace,
                  JSON.stringify({
                    session_name: session,
                    start_directory: project,
                    before_script: `${quote(runtime)} ${quote(join(project, "before.cjs"))}`,
                    windows: [
                      { window_name: "editor", panes: [`printf ready > ${quote(marker)}`, null] },
                      { window_name: "logs", panes: [null] },
                    ],
                  }),
                );
                const socket = ["-S", fixture.socketPath];
                const cases = [
                  ["load", workspace, "-d", ...socket],
                  ["freeze", session, ...socket],
                  ["ls", "--full"],
                  ["search", `session:${session}`, "-F"],
                  ["convert", workspace],
                  ["import", "teamocil", "teamocil.yaml"],
                  ["import", "tmuxinator", "tmuxinator.yaml"],
                  ["edit", workspace],
                  ["debug-info"],
                  [
                    "shell",
                    session,
                    "--code",
                    "--no-startup",
                    "-c",
                    "print(session.name)",
                    ...socket,
                  ],
                ];
                for (const args of cases) {
                  const result = await execute([runtime, executable, ...args, `--${mode}`], env);
                  assert.equal(result.stderr, "", args[0]);
                  assert(!result.stdout.includes("\u001b"), `${args[0]} emitted raw ANSI`);
                  const records =
                    mode === "json"
                      ? [JSON.parse(result.stdout)]
                      : result.stdout
                          .trim()
                          .split("\n")
                          .map((line) => JSON.parse(line));
                  if (args[0] === "load") {
                    const terminal = records.at(-1);
                    assert.equal(terminal.status, "ok");
                    const item = terminal.results[0];
                    assert.equal(item.created_windows.length, 2);
                    assert.equal(item.created_panes.length, 3);
                    assert.equal(item.script_output.stdout, "bootstrap\tΔ\u001b[31m\n");
                    if (mode === "ndjson") {
                      assert.deepEqual(
                        records.map((item) => item.sequence),
                        records.map((_, index) => index + 1),
                      );
                      assert.equal(
                        records.filter((item) => ["completed", "failed"].includes(item.event))
                          .length,
                        1,
                      );
                    }
                    const deadline = performance.now() + 3000;
                    while (!(await Bun.file(marker).exists()) && performance.now() < deadline)
                      await sleep(20);
                    assert.equal(await readFile(marker, "utf8"), "ready");
                  } else if (args[0] === "freeze") {
                    const document = mode === "json" ? records[0] : records[0].workspace;
                    assert.equal(document.session_name, session);
                    assert.deepEqual(
                      document.windows.map((window: { panes: unknown[] }) => window.panes.length),
                      [2, 1],
                    );
                    assert.equal(document.windows[0].panes[0].start_directory, project);
                  } else if (args[0] === "shell") {
                    assert.equal(records.at(-1).stdout.trim().split("\n").at(-1), session);
                  } else if (args[0] === "convert" || args[0] === "import") {
                    const document = mode === "json" ? records[0] : records[0].workspace;
                    assert.equal(
                      document.session_name,
                      args[0] === "convert" ? session : "imported",
                    );
                  } else if (args[0] === "ls") {
                    const workspaces = mode === "json" ? records[0].workspaces : records;
                    assert(
                      workspaces.some(
                        (item: { session_name: string }) => item.session_name === session,
                      ),
                    );
                  } else if (args[0] === "search") {
                    const found = mode === "json" ? records[0] : records;
                    assert.equal(found[0].session_name, session);
                  } else if (args[0] === "edit") {
                    assert.equal(records[0].stdout, workspace);
                  } else if (args[0] === "debug-info") {
                    assert.equal(records[0].port, "typescript");
                  }
                  checked++;
                }
              }
              const monochrome = await execute([runtime, executable, "--color", "always", "ls"], {
                ...env,
                NO_COLOR: "1",
              });
              assert.equal(monochrome.stderr, "");
              assert(!monochrome.stdout.includes("\u001b"));
            }
            process.stdout.write(
              `Installed CLI: ${checked} invocations passed on Node 22 and Bun\n`,
            );
          },
          () => fixture.dispose(),
        );
      },
      tmux,
    );
  },
  () => rm(project, { recursive: true, force: true }),
);
