import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  makeTestDirectory,
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
} from "../../src/_internal/test/testkit.js";

import { Server } from "../../src/server.js";

/**
 * The socket a `Server` addresses when it is given none, against real tmux.
 *
 * Every environment below points `TMUX_TMPDIR` at a directory of this test's
 * own and clears `TMUX` unless a case sets it, so a rule that failed to hold
 * would land on an empty server here and not on the developer's.
 */

interface World {
  readonly directory: string;
  readonly fixture: TestServer;
  /** The environment of a process that has chosen nothing, plus `extra`. */
  environment(
    extra?: Readonly<Record<string, string | undefined>>,
  ): Readonly<Record<string, string | undefined>>;
  /** Where tmux puts a socket of this name in the private directory. */
  socketIn(name: string): string;
  server(extra?: Readonly<Record<string, string | undefined>>): Server;
}

async function withWorld(body: (world: World) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-sock-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  // tmux falls back to /tmp, and so to the developer's sockets, when
  // TMUX_TMPDIR names a directory that does not exist.
  const tmpdir = join(parent, "t");
  await mkdir(tmpdir, { mode: 0o700 });
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "sock" });
        const environment: World["environment"] = (extra = {}) => ({
          ...fixture.controllerEnvironment,
          LIBTMUX_SOCKET: undefined,
          LIBTMUX_SOCKET_PATH: undefined,
          TMUX: undefined,
          TMUX_PANE: undefined,
          TMUX_TMPDIR: tmpdir,
          ...extra,
        });
        await runWithCleanup(
          () =>
            body({
              directory: parent,
              environment,
              fixture,
              server: (extra) =>
                new Server({
                  configFile: "/dev/null",
                  environment: environment(extra),
                  tmuxBin: fixture.tmuxExecutable,
                }),
              socketIn: (name) => join(tmpdir, `tmux-${String(process.getuid?.() ?? 0)}`, name),
            }),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

async function isSocket(path: string): Promise<boolean> {
  return stat(path).then(
    (metadata) => metadata.isSocket(),
    () => false,
  );
}

describe("a Server that is given no socket", () => {
  test("reaches the server LIBTMUX_SOCKET_PATH names", async () => {
    await withWorld(async (world) => {
      const server = world.server({ LIBTMUX_SOCKET_PATH: world.fixture.socketPath });

      const snapshot = await server.snapshot();

      expect(snapshot.sessions.exists({ name: world.fixture.sessionName })).toBe(true);
      expect(await isSocket(world.socketIn("default"))).toBe(false);
    });
  }, 40_000);

  test("reaches the server LIBTMUX_SOCKET names, under tmux's own directory", async () => {
    await withWorld(async (world) => {
      const server = world.server({ LIBTMUX_SOCKET: "ltx-named" });

      await runWithCleanup(
        async () => {
          await server.newSession({ name: "named" });

          expect(await isSocket(world.socketIn("ltx-named"))).toBe(true);
          expect(await isSocket(world.socketIn("default"))).toBe(false);
          expect(await server.hasSession("named")).toBe(true);
          expect(await world.server().hasSession("named")).toBe(false);
        },
        () => server.kill().catch(() => undefined),
      );
    });
  }, 40_000);

  test("prefers LIBTMUX_SOCKET_PATH when both variables are set", async () => {
    await withWorld(async (world) => {
      const server = world.server({
        LIBTMUX_SOCKET: "ltx-ignored",
        LIBTMUX_SOCKET_PATH: world.fixture.socketPath,
      });

      expect(await server.hasSession(world.fixture.sessionName)).toBe(true);
      expect(await isSocket(world.socketIn("ltx-ignored"))).toBe(false);
    });
  }, 40_000);

  test("leaves the choice to tmux when no variable is set: its default socket", async () => {
    await withWorld(async (world) => {
      const server = world.server();

      await runWithCleanup(
        async () => {
          expect(await server.isAlive()).toBe(false);
          await server.newSession({ name: "bare" });

          expect(await isSocket(world.socketIn("default"))).toBe(true);
          expect(await server.hasSession(world.fixture.sessionName)).toBe(false);
        },
        () => server.kill().catch(() => undefined),
      );
    });
  }, 40_000);

  test("leaves the choice to tmux inside tmux: the server TMUX names", async () => {
    await withWorld(async (world) => {
      // The fixture's path holds a comma, which TMUX cannot carry, so this
      // starts the server TMUX names on a socket of its own.
      const named = world.server({ LIBTMUX_SOCKET: "ltx-pane" });
      await runWithCleanup(
        async () => {
          await named.newSession({ name: "pane" });
          const server = world.server({ TMUX: `${world.socketIn("ltx-pane")},1,0` });

          expect(await server.hasSession("pane")).toBe(true);
          expect(await isSocket(world.socketIn("default"))).toBe(false);
        },
        () => named.kill().catch(() => undefined),
      );
    });
  }, 40_000);

  test("takes a variable over the server TMUX names", async () => {
    await withWorld(async (world) => {
      const named = world.server({ LIBTMUX_SOCKET: "ltx-pane" });
      await runWithCleanup(
        async () => {
          await named.newSession({ name: "pane" });
          const server = world.server({
            LIBTMUX_SOCKET: "ltx-elsewhere",
            TMUX: `${world.socketIn("ltx-pane")},1,0`,
          });

          expect(await server.isAlive()).toBe(false);
          expect(await server.hasSession("pane")).toBe(false);
          expect(await isSocket(world.socketIn("ltx-elsewhere"))).toBe(false);
        },
        () => named.kill().catch(() => undefined),
      );
    });
  }, 40_000);

  test("takes the socket the caller gives over both variables", async () => {
    await withWorld(async (world) => {
      const server = new Server({
        configFile: "/dev/null",
        environment: world.environment({
          LIBTMUX_SOCKET: "ltx-ignored",
          LIBTMUX_SOCKET_PATH: join(world.directory, "ltx-ignored.sock"),
        }),
        socketPath: world.fixture.socketPath,
        tmuxBin: world.fixture.tmuxExecutable,
      });

      expect(await server.hasSession(world.fixture.sessionName)).toBe(true);
    });
  }, 40_000);
});
