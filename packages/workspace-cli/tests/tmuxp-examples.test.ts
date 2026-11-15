/* eslint-disable no-await-in-loop -- Each example gets a server of its own, one after another. */
import { expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "libtmux";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/testkit.js";

/**
 * Every workspace file in tmuxp's `examples/` directory, loaded by
 * `tmux-workspace load -d` as a user would run it.
 *
 * The files are tmuxp's, unmodified, and live in `fixtures/tmuxp-examples/`
 * (see the README there). Each one gets its own tmux server on an explicit
 * `-S` socket, because `options.yaml` sets server-wide options and two
 * examples share a session name. A file the CLI refuses fails the test unless
 * its entry below says it is refused and why.
 *
 * The windows and panes each build should show are the file's structure in
 * `fixtures/tmuxp-examples/expected/`, which `tmuxp-structure.test.ts` holds the
 * loader to: window indexes, names, pane counts and the start directories a
 * file declares. Only what exists once the build returns is read, so pane
 * contents and timing-dependent keys are not compared.
 */

interface Loads {
  /** The session the example builds; a function when the name takes values from the environment. */
  session: string | ((root: string) => string);
  /** Files and variables the example reads from its surroundings, made under `root`. */
  needs?: (root: string) => Promise<Record<string, string>>;
  /** Whether the panes' start directories are compared; false where they take values from `needs`. */
  directories?: false;
  /** The effect the example exists to show, looked at after the load. */
  inspect?: (server: Server, session: string, root: string) => Promise<void>;
}

interface Refused {
  /** The error `code` in the JSON the CLI prints to stderr. */
  code: string;
  /** Text the error `message` contains. */
  message: string;
  /** What the example is loaded with. */
  environment: Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Where an example takes a value from the environment, the documented
 * substitution is `${NAME}` or `$NAME` read from the CLI's own environment, and
 * `~` is the home directory. These supply those values under the test's
 * private directory.
 */
const examples: Record<string, Loads | Refused> = {
  "2-pane-synchronized.yaml": {
    session: "2-pane-synchronized",
  },
  "2-pane-vertical.yaml": {
    session: "2-pane-vertical",
  },
  "3-pane.yaml": {
    session: "3-panes",
  },
  "4-pane.yaml": {
    session: "4-pane-split",
  },
  "blank-panes.yaml": {
    session: "Blank pane test",
  },
  // `${PWD}/test` must be a directory, and `before_script` must run, so the
  // variables name a work directory and a script that leaves a marker. The
  // second window sets `automatic-rename`, so tmux renames it from its pane.
  "env-variables.yaml": {
    session: (root) => `session - tmuxp (${join(root, "scripts")})`,
    directories: false,
    needs: async (root) => {
      const script = join(root, "scripts", "test3.sh");
      await mkdir(join(root, "work", "test"), { recursive: true });
      await mkdir(join(root, "scripts"));
      await writeFile(script, '#!/bin/sh\n: > "$(dirname "$0")/ran"\n');
      await chmod(script, 0o755);
      return { MY_ENV_VAR: join(root, "scripts"), PWD: join(root, "work"), USER: "tmuxp" };
    },
    inspect: async (_server, _session, root) => {
      expect(await exists(join(root, "scripts", "ran"))).toBe(true);
    },
  },
  "focus-window-and-panes.yaml": {
    session: "focus",
  },
  "main-pane-height-percentage.yaml": {
    session: "main-pane-height",
  },
  "main-pane-height.yaml": {
    session: "main-pane-height",
  },
  "minimal.yaml": {
    session: "My tmux session",
  },
  // `${MAIN_PANE_HEIGHT}` is the one variable; the session's `options` reach
  // every window, so the first one shows whether the value arrived.
  "options.yaml": {
    session: "test window options",
    needs: async () => ({ MAIN_PANE_HEIGHT: "30" }),
    inspect: async (server, session) => {
      expect(
        await server.cmd("show-options", ["-wv", "-t", `${session}:0`, "main-pane-height"]),
      ).toEqual(["30"]);
    },
  },
  "pane-shell.yaml": {
    session: "Pane shell example",
  },
  // `plugins` runs through a tmuxp Python bridge that needs tmuxp 1.74.0, and
  // names a package the example does not ship. No environment loads this file
  // as it stands, so the interpreter is pinned to a missing one and the
  // refusal is asserted rather than left to whatever Python the host has.
  "plugin-system.yaml": {
    code: "script_failed",
    message: "Python extensions require tmuxp 1.74.0",
    environment: { TMUX_WORKSPACE_PYTHON: "/missing-python" },
  },
  "session-environment.yaml": {
    session: "Environment variables test",
  },
  "shorthands.yaml": {
    session: "shorthands",
  },
  "skip-send-pane-level.yaml": {
    session: "Skip command execution (pane-level)",
  },
  "skip-send.yaml": {
    session: "Skip command execution (command-level)",
  },
  "sleep-pane-level.yaml": {
    session: "Pause / skip command execution (pane-level)",
  },
  "sleep-virtualenv.yaml": {
    session: "virtualenv",
  },
  "sleep.yaml": {
    session: "Pause / skip command execution (command-level)",
  },
  "start-directory.yaml": {
    session: "start directory",
  },
  "suppress-history.yaml": {
    session: "suppress",
  },
  // `window_index` places `five` at 5; the others take the next free index.
  "window-index.yaml": {
    session: "Window index example",
  },
};

const fixtures = new URL("./fixtures/tmuxp-examples/", import.meta.url).pathname;
const main = new URL("../src/main.ts", import.meta.url).pathname;

/** The windows a file builds, in index order, with the directory each pane is declared to start in. */
async function expectedTree(
  file: string,
  root: string,
): Promise<{ index: number; name: string | null; panes: (string | null)[] }[]> {
  const text = (
    await readFile(join(fixtures, "expected", file.replace(/\.yaml$/u, ".json")), "utf8")
  )
    .replaceAll("${WORKSPACE_DIR}", fixtures.replace(/\/$/u, ""))
    .replaceAll("${HOME}", join(root, "home"));
  const { windows } = JSON.parse(text) as {
    windows: {
      index: number;
      name: string | null;
      options: Record<string, unknown>;
      panes: { start_directory: string | null }[];
    }[];
  };
  return windows
    .map(({ index, name, options, panes }) => ({
      index,
      // A window that renames itself from its pane is not compared by name.
      name: [true, "on"].includes(options["automatic-rename"] as boolean | string) ? null : name,
      panes: panes.map((pane) => pane.start_directory),
    }))
    .toSorted((a, b) => a.index - b.index);
}

async function load(file: string, expected: Loads | Refused): Promise<void> {
  const root = await makeTestDirectory("ltx-wcli-tmuxp-");
  const home = join(root, "home");
  const tmuxTmpdir = join(root, "t");
  const socketPath = join(root, "sock");
  assertOwnedSocketPath(socketPath);
  // tmux falls back to /tmp when TMUX_TMPDIR does not exist, so both exist
  // before anything runs.
  await mkdir(home);
  await mkdir(tmuxTmpdir, { mode: 0o700 });
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !["TMUX", "TMUX_PANE", "LIBTMUX_SOCKET", "LIBTMUX_SOCKET_PATH"].includes(entry[0]),
      ),
    ),
    HOME: home,
    SHELL: "/bin/sh",
    TMUX_TMPDIR: tmuxTmpdir,
    ...(process.env.LIBTMUX_TEST_TMUX ? { TMUX_BIN: process.env.LIBTMUX_TEST_TMUX } : {}),
  };
  const server = new Server({
    environment,
    socketPath,
    ...(process.env.LIBTMUX_TEST_TMUX ? { tmuxBin: process.env.LIBTMUX_TEST_TMUX } : {}),
  });
  await runWithCleanup(
    async () => {
      const provided = "needs" in expected ? await expected.needs?.(root) : undefined;
      const child = Bun.spawn(
        [process.execPath, main, "load", "-d", "-S", socketPath, join(fixtures, file), "--json"],
        {
          cwd: root,
          env: {
            ...environment,
            ...provided,
            ...("environment" in expected ? expected.environment : {}),
          },
          killSignal: "SIGKILL",
          stderr: "pipe",
          stdout: "pipe",
          timeout: 60_000,
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}${stderr}`;

      if ("code" in expected) {
        expect(code, output).toBe(1);
        expect(JSON.parse(stderr.trim().split("\n").at(-1)!)).toMatchObject({
          code: expected.code,
        });
        expect(stderr).toContain(expected.message);
        expect(await server.isAlive(), "a refused load starts no server").toBe(false);
        return;
      }

      expect(code, output).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ status: "ok", errors: [] });
      const name =
        typeof expected.session === "function" ? expected.session(root) : expected.session;
      const sessions = (await server.snapshot()).sessions.toArray();
      expect(sessions.map((session) => session.name)).toEqual([name]);
      const built = sessions[0]!.windows
        .toArray()
        .map((window) => ({
          index: Number(window.index),
          name: window.name,
          panes: window.panes
            .toArray()
            .toSorted((a, b) => Number(a.index) - Number(b.index))
            .map((pane) => pane.startPath),
        }))
        .toSorted((a, b) => a.index - b.index);
      const tree = await expectedTree(file, root);
      // An unnamed or self-renaming window takes the name tmux gives it, so its name is not compared.
      expect(
        built.map(({ index, name: windowName, panes }) => ({
          index,
          name: windowName,
          panes: panes.length,
        })),
      ).toEqual(
        tree.map(({ index, name: windowName, panes }, position) => ({
          index,
          name: windowName ?? built[position]?.name ?? null,
          panes: panes.length,
        })),
      );
      if (expected.directories !== false) {
        for (const [position, window] of tree.entries()) {
          for (const [paneIndex, directory] of window.panes.entries()) {
            // A pane the file gives no directory starts where the CLI ran.
            expect(built[position]!.panes[paneIndex], `${file} window ${window.index}`).toBe(
              directory ?? root,
            );
          }
        }
      }
      await expected.inspect?.(server, name, root);
    },
    async () => {
      await server.kill().catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    },
  );
}

test("every tmuxp example workspace loads through the CLI", async () => {
  const files = (await readdir(fixtures)).filter((name) => name.endsWith(".yaml")).sort();
  expect(
    Object.keys(examples).sort(),
    "every fixture has an entry and every entry a fixture",
  ).toEqual(files);

  const failures: string[] = [];
  for (const file of files) {
    try {
      await load(file, examples[file]!);
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  expect(failures).toEqual([]);
}, 300_000);
