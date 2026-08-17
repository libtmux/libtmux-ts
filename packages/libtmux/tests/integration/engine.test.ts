import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";
import { Server } from "../../src/server.js";
import { asSingleInvocation, guardRequest, MAX_PACKED_ARGV_BYTES } from "../../src/engine.js";
import type {
  DaemonGuard,
  TmuxCommandRequest,
  TmuxCommandResult,
  TmuxEngine,
} from "../../src/engine.js";

/**
 * An engine that reaches tmux the long way round.
 *
 * `sh -c` is standing in for ssh or `docker exec`: what matters is that the
 * library never spawns tmux itself and everything above the seam — capability
 * binding, acquisition, the graph, queries, mutations — still works. If the
 * seam were at the graph instead, this would have to reimplement framing.
 */
function shellEngine(onInvocation: (argv: readonly string[]) => void): TmuxEngine {
  const run = async (
    executable: string,
    args: readonly string[],
    environment: Readonly<Record<string, string | undefined>> | undefined,
    stdin: Uint8Array | undefined,
  ): Promise<TmuxCommandResult> => {
    onInvocation([executable, ...args]);
    const quoted = [executable, ...args]
      .map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`)
      .join(" ");
    const child = Bun.spawn(["sh", "-c", quoted], {
      env: { ...environment },
      ...(stdin === undefined ? {} : { stdin }),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    return {
      cmd: [executable, ...args],
      returncode: code,
      signal: null,
      stderr: new Uint8Array(stderr),
      stdout: new Uint8Array(stdout),
    };
  };

  return {
    execute: (request: TmuxCommandRequest) => {
      // The obligation an engine is least likely to meet by accident. Dropping
      // it costs nothing until a daemon restarts, and then a handle read before
      // the restart addresses whatever now holds its id.
      const guarded = guardRequest(request);
      return run(guarded.executable, guarded.args, guarded.environment, guarded.stdin);
    },
    async executeGroup(requests: readonly TmuxCommandRequest[]) {
      const [first] = requests;
      if (first === undefined) return [];
      // The helper the built-in engine uses. Running these separately would
      // return the same rows and stop the snapshot being one instant.
      const invocation = asSingleInvocation(requests);
      // The ceiling an engine has to respect, published for exactly this: a
      // tmux client packs its whole argv into one imsg and refuses past it.
      const packed = [first.executable, ...invocation.args].reduce(
        (total, argument) => total + Buffer.byteLength(argument, "utf8") + 1,
        0,
      );
      if (packed > MAX_PACKED_ARGV_BYTES) throw new Error("command list is too long for tmux");
      const result = await run(first.executable, invocation.args, first.environment, undefined);
      const sections = invocation.sections(result.stdout);
      return sections.map((stdout, index) => ({
        cmd: result.cmd,
        returncode: index === sections.length - 1 ? result.returncode : 0,
        signal: null,
        stderr: index === sections.length - 1 ? result.stderr : new Uint8Array(),
        stdout,
      }));
    },
  };
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-engine-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "engine" });
        await runWithCleanup(
          () => body(fixture),
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

describe("a supplied engine", () => {
  test("carries the whole library, and the library spawns nothing itself", async () => {
    await withServer(async (fixture) => {
      const invocations: (readonly string[])[] = [];
      const server = new Server({
        engine: shellEngine((argv) => invocations.push(argv)),
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const window = await (await server.snapshot()).sessions.one().newWindow({ name: "remote" });
      expect(window.name).toBe("remote");

      // An engine sees the guard it is obliged to honour, and honouring it is
      // one published call rather than a reimplementation of `if-shell -F`,
      // the impossible else branch, and the stderr that tells a refusal from a
      // failure. What reaches tmux is what the built-in engine would have sent.
      const guards: (DaemonGuard | undefined)[] = [];
      const sent: (readonly string[])[] = [];
      const guarded = new Server({
        engine: {
          execute: (request) => {
            guards.push(request.daemonGuard);
            sent.push(guardRequest(request).args);
            return shellEngine(() => undefined).execute(request);
          },
          executeGroup: (requests) => shellEngine(() => undefined).executeGroup(requests),
        },
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      await (
        await guarded.snapshot()
      ).windows
        .one({ name: "remote" })
        .setOption("main-pane-width", "81");
      expect(guards.some((guard) => guard !== undefined)).toBe(true);

      const wrapped = sent.filter((argv) => argv.includes("if-shell"));
      expect(wrapped).not.toBeEmpty();
      for (const argv of wrapped) {
        expect(argv).toContain("-F");
        // The else branch is what makes a refusal visible: tmux answers a false
        // condition with no output and status 0, which reads as a command that
        // printed nothing.
        expect(argv.at(-1)).toContain("libtmux-daemon-restarted");
      }

      const snapshot = await server.snapshot();
      expect(snapshot.windows.count({ name: "remote" })).toBe(1);
      expect(snapshot.panes.count()).toBeGreaterThan(0);

      // Everything reached tmux through the engine, including the version
      // probe and the acquisition — nothing bypassed it.
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((argv) => argv[0] === fixture.tmuxExecutable)).toBe(true);

      // And acquisition still went as one invocation, which is what keeps a
      // snapshot one instant however far away tmux is.
      const listings = invocations.filter((argv) =>
        argv.some((argument) => argument.startsWith("list-")),
      );
      expect(listings).not.toBeEmpty();
      for (const argv of listings) {
        expect(argv.filter((argument) => argument.startsWith("list-"))).toHaveLength(4);
      }
    });
  }, 60_000);

  test("echoes the engine back, the way it echoes every other option", async () => {
    await withServer(async (fixture) => {
      const engine = shellEngine(() => undefined);
      const shared = {
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      };

      // What a caller downstream needs to know before reaching for a call
      // that only a local tmux can answer.
      expect(new Server({ ...shared, engine }).engine).toBe(engine);
      expect(new Server(shared).engine).toBeUndefined();
    });
  }, 60_000);

  test("refuses the two calls that can only drive a local tmux", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        engine: shellEngine(() => undefined),
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      // Both hold a `tmux -C attach` process open, which this process spawns.
      // An engine exists to put tmux somewhere this process cannot spawn it,
      // so quietly attaching to a local one would run the caller's commands
      // against the wrong machine and report success.
      expect(() => server.watch()).toThrow(/engine/u);
      await expect(server.connect()).rejects.toThrow(/engine/u);
    });
  }, 60_000);

  test("keeps an engine when the environment asks for control mode", async () => {
    await withServer(async (fixture) => {
      const invocations: (readonly string[])[] = [];
      // Set by whoever started the process, not by the caller who supplied the
      // engine. The engine is the more specific instruction, so it wins.
      await using opened = await Server.open({
        engine: shellEngine((argv) => invocations.push(argv)),
        environment: { ...fixture.controllerEnvironment, LIBTMUX_TRANSPORT: "control" },
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      expect((await opened.snapshot()).sessions.count()).toBeGreaterThan(0);
      expect(invocations).not.toBeEmpty();
    });
  }, 60_000);

  test("refuses a control transport asked for in the same breath as an engine", async () => {
    // Ambient configuration is ignored; a contradiction the caller wrote on
    // purpose is refused, the way socketName and socketPath are.
    await expect(
      Server.open({ engine: shellEngine(() => undefined), transport: "control" }),
    ).rejects.toThrow(TypeError);
  }, 60_000);

  test("tells two engines apart when they say where they reach", async () => {
    await withServer(async (fixture) => {
      const at = (endpoint: string): Server =>
        new Server({
          engine: { ...shellEngine(() => undefined), endpoint },
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });

      // Same socket path, different machines. Comparing only the socket is
      // what made these look like one server.
      expect(at("ssh://build-01").equals(at("ssh://build-02"))).toBe(false);
      expect(at("ssh://build-01").equals(at("ssh://build-01"))).toBe(true);
    });
  }, 60_000);

  test("never calls an engine that cannot say where it reaches equal to another", async () => {
    await withServer(async (fixture) => {
      const anonymous = (): Server =>
        new Server({
          engine: shellEngine(() => undefined),
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });

      // An engine that declares no endpoint knows something this does not.
      // Answering "same server" from the socket alone is the guess that was
      // wrong; answering "different" costs a caller a comparison they can make
      // themselves.
      expect(anonymous().equals(anonymous())).toBe(false);
    });
  }, 60_000);
});
