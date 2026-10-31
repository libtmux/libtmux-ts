/* eslint-disable no-await-in-loop -- Each case runs the command and then looks at what it left. */
import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { Server } from "libtmux";
import type { CLIContext } from "../src/app.ts";
import { connection, serverEnvironment } from "../src/tmux.ts";
import { makeTestDirectory, runWithCleanup } from "../../libtmux/src/_internal/test/testkit.js";

/**
 * Which socket the commands use when `-S` and `-L` name none: the one
 * `LIBTMUX_SOCKET_PATH` or `LIBTMUX_SOCKET` names, else whichever tmux picks.
 *
 * Every command here runs with `TMUX_TMPDIR` in a directory of the test's own,
 * so a rule that failed to hold lands on an empty server there and not on the
 * developer's. tmux falls back to `/tmp` when that directory does not exist, so
 * it is made first.
 */

interface World {
  readonly directory: string;
  /** The environment of a command that has chosen nothing, plus `extra`. */
  environment(extra?: Record<string, string>): Record<string, string>;
  /** A server on the named socket in the private directory, for looking and for cleanup. */
  named(name: string): Server;
  /** What tmux exports into a pane of the server `name`, which must have a session. */
  paneOf(name: string): Promise<{ TMUX: string; TMUX_PANE: string }>;
  run(
    argv: string[],
    extra?: Record<string, string>,
  ): Promise<{ code: number; stderr: string; stdout: string }>;
  workspace(name: string): Promise<string>;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const directory = await makeTestDirectory("ltx-wcli-sock-");
  const tmuxTmpdir = join(directory, "t");
  await mkdir(tmuxTmpdir, { mode: 0o700 });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["TMUX", "TMUX_PANE", "LIBTMUX_SOCKET", "LIBTMUX_SOCKET_PATH"].includes(entry[0]),
    ),
  );
  const environment = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...inherited,
    HOME: directory,
    TMUX_TMPDIR: tmuxTmpdir,
    ...(process.env.LIBTMUX_TEST_TMUX ? { TMUX_BIN: process.env.LIBTMUX_TEST_TMUX } : {}),
    ...extra,
  });
  const opened: Server[] = [];
  const named = (name: string): Server => {
    const server = new Server({
      environment: environment(),
      socketName: name,
      ...(process.env.LIBTMUX_TEST_TMUX ? { tmuxBin: process.env.LIBTMUX_TEST_TMUX } : {}),
    });
    opened.push(server);
    return server;
  };
  await runWithCleanup(
    () =>
      body({
        directory,
        environment,
        named,
        paneOf: async (name) => {
          const server = named(name);
          const snapshot = await server.snapshot();
          const pane = snapshot.panes.at(0);
          if (pane === undefined) throw new Error(`${name} has no pane`);
          const { pid } = await server.daemonIdentity();
          return {
            TMUX: `${join(tmuxTmpdir, `tmux-${String(process.getuid?.() ?? 0)}`, name)},${pid},0`,
            TMUX_PANE: pane.id,
          };
        },
        run: async (argv, extra) => {
          const child = Bun.spawn(
            [process.execPath, new URL("../src/main.ts", import.meta.url).pathname, ...argv],
            { cwd: directory, env: environment(extra), stderr: "pipe", stdout: "pipe" },
          );
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { code, stderr, stdout };
        },
        workspace: async (name) => {
          const path = join(directory, `${name}.json`);
          await writeFile(path, JSON.stringify({ session_name: name, windows: [{}] }));
          return path;
        },
      }),
    async () => {
      for (const server of opened) await server.kill().catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    },
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const socketIn = (world: World, name: string): string =>
  join(world.directory, "t", `tmux-${String(process.getuid?.() ?? 0)}`, name);

async function sessionsOn(server: Server): Promise<(string | null)[]> {
  if (!(await server.isAlive())) return [];
  return (await server.snapshot()).sessions.toArray().map((session) => session.name);
}

test("load puts the workspace on the socket LIBTMUX_SOCKET_PATH names", async () => {
  await withWorld(async (world) => {
    const path = join(world.directory, "chosen.sock");
    const file = await world.workspace("by-path");

    const result = await world.run(["load", file, "-d", "--json"], { LIBTMUX_SOCKET_PATH: path });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    const server = new Server({ environment: world.environment(), socketPath: path });
    try {
      expect(await sessionsOn(server)).toEqual(["by-path"]);
      expect(await exists(socketIn(world, "default"))).toBe(false);
    } finally {
      await server.kill().catch(() => undefined);
    }
  });
}, 60_000);

test("load puts the workspace on the socket LIBTMUX_SOCKET names", async () => {
  await withWorld(async (world) => {
    const file = await world.workspace("by-name");

    const result = await world.run(["load", file, "-d", "--json"], {
      LIBTMUX_SOCKET: "ltx-by-name",
    });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(await sessionsOn(world.named("ltx-by-name"))).toEqual(["by-name"]);
    expect(await exists(socketIn(world, "default"))).toBe(false);
  });
}, 60_000);

test("load takes LIBTMUX_SOCKET_PATH when both variables are set", async () => {
  await withWorld(async (world) => {
    const path = join(world.directory, "chosen.sock");
    const file = await world.workspace("both");

    const result = await world.run(["load", file, "-d", "--json"], {
      LIBTMUX_SOCKET: "ltx-ignored",
      LIBTMUX_SOCKET_PATH: path,
    });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    const server = new Server({ environment: world.environment(), socketPath: path });
    try {
      expect(await sessionsOn(server)).toEqual(["both"]);
      expect(await exists(socketIn(world, "ltx-ignored"))).toBe(false);
    } finally {
      await server.kill().catch(() => undefined);
    }
  });
}, 60_000);

test("load takes -L and -S over both variables", async () => {
  await withWorld(async (world) => {
    const path = join(world.directory, "flagged.sock");
    const variables = {
      LIBTMUX_SOCKET: "ltx-ignored",
      LIBTMUX_SOCKET_PATH: "/nonexistent/ignored",
    };

    const byName = await world.run(
      ["load", await world.workspace("flag-name"), "-d", "--json", "-L", "ltx-flagged"],
      variables,
    );
    const byPath = await world.run(
      ["load", await world.workspace("flag-path"), "-d", "--json", "-S", path],
      variables,
    );

    expect(byName.code, byName.stdout + byName.stderr).toBe(0);
    expect(byPath.code, byPath.stdout + byPath.stderr).toBe(0);
    expect(await sessionsOn(world.named("ltx-flagged"))).toEqual(["flag-name"]);
    const server = new Server({ environment: world.environment(), socketPath: path });
    try {
      expect(await sessionsOn(server)).toEqual(["flag-path"]);
      expect(await exists(socketIn(world, "ltx-ignored"))).toBe(false);
    } finally {
      await server.kill().catch(() => undefined);
    }
  });
}, 90_000);

test("load leaves the socket to tmux when nothing names one: its default", async () => {
  await withWorld(async (world) => {
    const file = await world.workspace("bare");

    const result = await world.run(["load", file, "-d", "--json"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(await sessionsOn(world.named("default"))).toEqual(["bare"]);
  });
}, 60_000);

test("load inside tmux leaves the socket to tmux: the server TMUX names", async () => {
  await withWorld(async (world) => {
    await world.named("ltx-pane").newSession({ name: "pane" });
    const pane = await world.paneOf("ltx-pane");
    const file = await world.workspace("inside");

    const result = await world.run(["load", file, "-d", "--json"], pane);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(
      (await sessionsOn(world.named("ltx-pane"))).toSorted((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    ).toEqual(["inside", "pane"]);
    expect(await exists(socketIn(world, "default"))).toBe(false);
  });
}, 60_000);

test("load inside tmux takes a variable over the server TMUX names", async () => {
  await withWorld(async (world) => {
    await world.named("ltx-pane").newSession({ name: "pane" });
    const pane = await world.paneOf("ltx-pane");
    const file = await world.workspace("elsewhere");

    const result = await world.run(["load", file, "-d", "--json"], {
      ...pane,
      LIBTMUX_SOCKET: "ltx-elsewhere",
    });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(await sessionsOn(world.named("ltx-elsewhere"))).toEqual(["elsewhere"]);
    expect(await sessionsOn(world.named("ltx-pane"))).toEqual(["pane"]);
  });
}, 60_000);

test("append inside tmux asks for the TMUX socket and adds to the current session", async () => {
  await withWorld(async (world) => {
    await world.named("ltx-pane").newSession({ name: "pane" });
    const pane = await world.paneOf("ltx-pane");
    await writeFile(
      join(world.directory, "more.json"),
      JSON.stringify({ session_name: "ignored", windows: [{ window_name: "appended" }] }),
    );

    const result = await world.run(
      ["load", join(world.directory, "more.json"), "--append", "--json"],
      pane,
    );

    expect(result.code, result.stdout + result.stderr).toBe(0);
    const session = (await world.named("ltx-pane").snapshot()).sessions.one({ name: "pane" });
    expect(session.windows.exists({ name: "appended" })).toBe(true);
  });
}, 60_000);

test("append inside tmux refuses a variable that names another server than TMUX", async () => {
  await withWorld(async (world) => {
    await world.named("ltx-pane").newSession({ name: "pane" });
    await world.named("ltx-elsewhere").newSession({ name: "elsewhere" });
    const pane = await world.paneOf("ltx-pane");
    await writeFile(
      join(world.directory, "more.json"),
      JSON.stringify({ session_name: "ignored", windows: [{ window_name: "appended" }] }),
    );

    const result = await world.run(
      ["load", join(world.directory, "more.json"), "--append", "--json"],
      { ...pane, LIBTMUX_SOCKET: "ltx-elsewhere" },
    );

    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain("must target the current pane's tmux server");
    const sessions = (await world.named("ltx-pane").snapshot()).sessions;
    expect(sessions.one({ name: "pane" }).windows.exists({ name: "appended" })).toBe(false);
    const elsewhere = (await world.named("ltx-elsewhere").snapshot()).sessions;
    expect(elsewhere.one({ name: "elsewhere" }).windows.exists({ name: "appended" })).toBe(false);
  });
}, 60_000);

test("freeze reads the socket LIBTMUX_SOCKET names", async () => {
  await withWorld(async (world) => {
    await world.named("ltx-frozen").newSession({ name: "frozen" });

    const result = await world.run(["freeze", "--json"], { LIBTMUX_SOCKET: "ltx-frozen" });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).session_name).toBe("frozen");
  });
}, 60_000);

/**
 * tmuxp reads neither variable, so `shell` hands it a socket a variable chose
 * as a flag. The interpreter below records its arguments instead of starting
 * tmuxp.
 */
async function shellArguments(
  world: World,
  extra: Record<string, string>,
  flags: string[] = [],
): Promise<string[]> {
  const python = join(world.directory, "python");
  const log = join(world.directory, "shell.args");
  await writeFile(
    python,
    `#!/bin/sh\ncase "$*" in *importlib.metadata*) echo 1.74.0; exit 0;; esac\nfor argument in "$@"; do printf '%s\\n' "$argument"; done > '${log}'\nexit 0\n`,
  );
  await chmod(python, 0o700);
  const result = await world.run(["shell", "-c", "print(1)", ...flags], {
    TMUX_WORKSPACE_PYTHON: python,
    ...extra,
  });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return (await readFile(log, "utf8")).split("\n").slice(0, -1);
}

const socketFlags = (args: string[]): string[] =>
  args.flatMap((argument, index) =>
    argument === "-S" || argument === "-L" ? [argument, args[index + 1] ?? ""] : [],
  );

test("shell passes tmuxp the socket a variable chose, and none when tmux chooses", async () => {
  await withWorld(async (world) => {
    expect(socketFlags(await shellArguments(world, { LIBTMUX_SOCKET: "ltx-shell" }))).toEqual([
      "-L",
      "ltx-shell",
    ]);
    expect(
      socketFlags(await shellArguments(world, { LIBTMUX_SOCKET_PATH: "/tmp/ltx-shell.sock" })),
    ).toEqual(["-S", "/tmp/ltx-shell.sock"]);
    expect(
      socketFlags(
        await shellArguments(world, {
          LIBTMUX_SOCKET: "ltx-shell",
          LIBTMUX_SOCKET_PATH: "/tmp/ltx-shell.sock",
        }),
      ),
    ).toEqual(["-S", "/tmp/ltx-shell.sock"]);
    expect(
      socketFlags(
        await shellArguments(world, { LIBTMUX_SOCKET: "ltx-shell" }, ["-L", "ltx-flagged"]),
      ),
    ).toEqual(["-L", "ltx-flagged"]);
    expect(socketFlags(await shellArguments(world, {}))).toEqual([]);
  });
}, 60_000);

function contextFor(env: Record<string, string>): CLIContext {
  return {
    cwd: "/tmp",
    env,
    stderr: new Writable(),
    stdin: Readable.from([]),
    stdout: new Writable(),
  };
}

test("connection passes no socket for TMUX and keeps TMUX for tmux to follow", () => {
  const inside = contextFor({ TMUX: "/tmp/ltx-pane, sock,123,0", TMUX_PANE: "%3" });

  const server = connection({}, inside);

  expect(server.socketPath).toBeUndefined();
  expect(server.socketName).toBeUndefined();
  expect(serverEnvironment(server, inside)).toMatchObject({ TMUX: "/tmp/ltx-pane, sock,123,0" });
  expect(serverEnvironment(server, inside).TMUX_PANE).toBeUndefined();
});

test("connection reads the variables after the flags, and drops TMUX once a socket is chosen", () => {
  const inside = contextFor({
    LIBTMUX_SOCKET: "ltx-env",
    LIBTMUX_SOCKET_PATH: "/tmp/ltx-env.sock",
    TMUX: "/tmp/ltx-pane.sock,123,0",
    TMUX_PANE: "%3",
  });

  const byVariable = connection({}, inside);
  expect(byVariable.socketPath).toBe("/tmp/ltx-env.sock");
  expect(byVariable.socketName).toBeUndefined();
  expect(serverEnvironment(byVariable, inside).TMUX).toBeUndefined();

  expect(connection({ socket_path: "/tmp/ltx-flag.sock" }, inside).socketPath).toBe(
    "/tmp/ltx-flag.sock",
  );
  const named = connection({ socket_name: "ltx-flag" }, inside);
  expect(named.socketName).toBe("ltx-flag");
  expect(named.socketPath).toBeUndefined();
});
