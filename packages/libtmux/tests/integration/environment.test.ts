import { access, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  assertOwnedSocketPath,
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { TmuxCommandError } from "../../src/errors.js";
import type { Pane } from "../../src/pane.js";
import { Server } from "../../src/server.js";
import { runModule } from "../support/runtime_build.js";
import { waitForProcessExit } from "../support/converge.js";

/**
 * tmux environments against a real server.
 *
 * The three states a variable can be in — set, marked for removal, absent — are
 * the whole point of these, because they are what a `Map<string, string>` cannot
 * express and what the tmux command line reports in three different shapes.
 */

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-env-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "env" });
        await runWithCleanup(
          () => body(fixture),
          async () => {
            await fixture.dispose();
            await waitForProcessExit(fixture.daemonIdentity.pid);
          },
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

/** Poll a pane until its contents satisfy a predicate or the deadline passes. */
async function captureUntil(
  pane: Pane,
  matches: (lines: readonly string[]) => boolean,
  attempts = 100,
): Promise<readonly string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
    const lines = await pane.capture();
    if (matches(lines)) return lines;
    // eslint-disable-next-line no-await-in-loop -- Each wait follows the capture before it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pane never reached the expected contents");
}

async function sessionOf(fixture: TestServer) {
  const snapshot = await serverFor(fixture).snapshot();
  return snapshot.sessions.one();
}

describe("session environment", () => {
  test("round-trips a value through tmux", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);

      await session.setEnvironment("LTX_TOKEN", "abc123");

      expect(await session.getEnvironment("LTX_TOKEN")).toBe("abc123");
      expect((await session.showEnvironment()).get("LTX_TOKEN")).toBe("abc123");
    });
  }, 30_000);

  test("keeps a value that contains separators and spaces intact", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);
      // Only the first `=` separates a name from its value, so a value that
      // carries its own survives whole.
      const value = "a=b c=d  trailing ";

      await session.setEnvironment("LTX_ODD", value);

      expect(await session.getEnvironment("LTX_ODD")).toBe(value);
    });
  }, 30_000);

  test("answers undefined for a variable tmux does not carry", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);

      // tmux fails this lookup rather than returning nothing, and a name that
      // is simply absent is an answer, not a fault.
      expect(await session.getEnvironment("LTX_NEVER_SET")).toBeUndefined();
    });
  }, 30_000);

  test("distinguishes marked-for-removal from unset", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);
      await session.setEnvironment("LTX_GONE", "value");

      await session.removeEnvironment("LTX_GONE");

      // Still an entry, and what it says is "unset this before spawning".
      expect(await session.getEnvironment("LTX_GONE")).toBeNull();
      expect((await session.showEnvironment()).has("LTX_GONE")).toBe(true);

      await session.unsetEnvironment("LTX_GONE");

      expect(await session.getEnvironment("LTX_GONE")).toBeUndefined();
      expect((await session.showEnvironment()).has("LTX_GONE")).toBe(false);
    });
  }, 30_000);

  test("guards a variable name starting with a dash", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);
      // Read through the raw escape hatch rather than `getEnvironment`:
      // tmux's own removal-marker line is a bare `-NAME` with no `=`, which
      // is indistinguishable from a value-carrying line only when a name
      // legitimately starting with `-` is not also handled on the read
      // side — a separate, pre-existing gap this is not the fix for.
      const raw = async (): Promise<readonly string[]> =>
        session.cmd("show-environment", ["--", "-x"]);

      // `-h` is set-environment's own hidden flag and `-x` is none of its
      // flags; without the guard `-x` would be refused as one instead of
      // reaching a variable named `-x`.
      await session.setEnvironment("-x", "value");
      expect(await raw()).toEqual(["-x=value"]);

      await session.removeEnvironment("-x");
      expect(await raw()).toEqual(["--x"]);

      await session.unsetEnvironment("-x");
      const absent = await raw()
        .then(() => undefined)
        .catch((thrown: unknown) => thrown);
      expect(absent).toBeInstanceOf(TmuxCommandError);
      expect((absent as TmuxCommandError).stderrIncludes("unknown variable")).toBe(true);
    });
  }, 30_000);

  test("names a removal-marked variable without its marker", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);
      await session.removeEnvironment("LTX_MARKED");

      const environment = await session.showEnvironment();

      // tmux prints `-LTX_MARKED`; the marker is the state, not part of the name.
      expect(environment.has("LTX_MARKED")).toBe(true);
      expect(environment.has("-LTX_MARKED")).toBe(false);
      expect([...environment.keys()].every((name) => !name.startsWith("-"))).toBe(true);
    });
  }, 30_000);

  test("reaches a new pane's process environment", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);
      await session.setEnvironment("LTX_INHERITED", "inherited-value");

      // The point of a session environment is what a process tmux starts sees,
      // so the check is a process reading it rather than tmux reporting it back.
      const window = await session.newWindow({
        shellCommand: "printenv LTX_INHERITED; sleep 30",
      });
      const pane = window.panes.one();

      const lines = await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("inherited-value")),
      );

      expect(lines.some((line) => line.trim() === "inherited-value")).toBe(true);
    });
  }, 30_000);

  test("expands a tmux format only when asked", async () => {
    await withServer(async (fixture) => {
      const session = await sessionOf(fixture);

      await session.setEnvironment("LTX_LITERAL", "#{session_name}");
      await session.setEnvironment("LTX_EXPANDED", "#{session_name}", { expandFormat: true });

      expect(await session.getEnvironment("LTX_LITERAL")).toBe("#{session_name}");
      expect(await session.getEnvironment("LTX_EXPANDED")).toBe("env");
    });
  }, 30_000);
});

describe("server environment", () => {
  test("keeps the global environment separate from a session's", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await sessionOf(fixture);

      await server.setEnvironment("LTX_SCOPE", "global");
      await session.setEnvironment("LTX_SCOPE", "session");

      expect(await server.getEnvironment("LTX_SCOPE")).toBe("global");
      expect(await session.getEnvironment("LTX_SCOPE")).toBe("session");
    });
  }, 30_000);

  test("round-trips and clears a global variable", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      await server.setEnvironment("LTX_GLOBAL", "on");
      expect(await server.getEnvironment("LTX_GLOBAL")).toBe("on");

      await server.unsetEnvironment("LTX_GLOBAL");
      expect(await server.getEnvironment("LTX_GLOBAL")).toBeUndefined();
    });
  }, 30_000);
});

describe("ordinary example with external endpoint defaults", () => {
  for (const failures of ["none", "body", "cleanup", "both"] as const) {
    test(`runs the unchanged example and reports ${failures} failures`, async () => {
      const hostEnvironment = { ...process.env };
      let socketPath: string | undefined;
      let daemonPid: number | undefined;
      await withServer(async (fixture) => {
        socketPath = fixture.socketPath;
        daemonPid = fixture.daemonIdentity.pid;
        assertOwnedSocketPath(fixture.socketPath);
        const module = new URL(
          "Bun" in globalThis
            ? "../../../../examples/quickstart/default-session.ts"
            : "../../../../examples/quickstart/dist/default-session.js",
          import.meta.url,
        );
        const failBody = failures === "body" || failures === "both";
        const failCleanup = failures === "cleanup" || failures === "both";
        const result = runModule(
          `
          import { Server, ownSession } from "libtmux";
          ${failCleanup ? 'const probe = await ownSession(new Server()); const prototype = Object.getPrototypeOf(probe); await probe.dispose(); prototype.dispose = async () => { throw new Error("injected cleanup failure"); };' : ""}
          ${failBody ? 'console.log = (line) => { process.stdout.write(line + "\\n"); throw new Error("injected body failure"); };' : ""}
          try {
            await import(${JSON.stringify(module.href)});
          } catch (error) {
            process.stderr.write(JSON.stringify({
              name: error.name,
              message: error.message,
              cleanup: error.error?.message,
              body: error.suppressed?.message,
            }));
            process.exitCode = 1;
          }
        `,
          {
            ...fixture.controllerEnvironment,
            LIBTMUX_SOCKET_PATH: fixture.socketPath,
            LIBTMUX_SOCKET_NAME: "../ignored",
            TMUX: "invalid-lower-priority",
            TMUX_PANE: "%999",
            TMUX_TMPDIR: "ignored-relative-root",
          },
        );
        const created = JSON.parse(result.stdout) as {
          id: string;
          name: string;
          socketPath: string;
        };
        expect(created.socketPath).toBe(fixture.socketPath);
        expect(created.id).toMatch(/^\$\d+$/u);
        expect(created.name).toStartWith("example-");
        const snapshot = await serverFor(fixture).snapshot();
        expect(snapshot.sessions.exists({ id: fixture.sessionId })).toBe(true);
        expect(snapshot.sessions.exists({ id: created.id })).toBe(failCleanup);
        expect(result.exitCode).toBe(failures === "none" ? 0 : 1);
        if (failures === "none") expect(result.stderr).toBe("");
        else {
          const error = JSON.parse(result.stderr) as {
            name: string;
            message: string;
            cleanup?: string;
            body?: string;
          };
          if (failures === "both") {
            expect(error.name).toBe("SuppressedError");
            expect(error.cleanup).toBe("injected cleanup failure");
            expect(error.body).toBe("injected body failure");
          } else expect(error.message).toBe(`injected ${failures} failure`);
        }
      });
      if (socketPath === undefined || daemonPid === undefined)
        throw new Error("fixture did not start");
      await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await waitForProcessExit(daemonPid);
      expect({ ...process.env }).toEqual(hostEnvironment);
    }, 30_000);
  }
});

for (const interruption of ["timeout", "SIGTERM", "SIGKILL", "crash"] as const) {
  test(`outer harness reaps the unchanged ordinary example after ${interruption}`, async () => {
    const hostEnvironment = { ...process.env };
    let pid: number | undefined;
    await withServer(async (fixture) => {
      pid = fixture.daemonIdentity.pid;
      const module = new URL(
        "Bun" in globalThis
          ? "../../../../examples/quickstart/default-session.ts"
          : "../../../../examples/quickstart/dist/default-session.js",
        import.meta.url,
      );
      const interrupt =
        interruption === "crash"
          ? "process.exit(37);"
          : interruption === "timeout"
            ? ""
            : `process.kill(process.pid, ${JSON.stringify(interruption)});`;
      const result = runModule(
        `
        console.log = (line) => {
          process.stdout.write(line + "\\n");
          ${interrupt}
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
        };
        await import(${JSON.stringify(module.href)});
      `,
        { ...fixture.controllerEnvironment, LIBTMUX_SOCKET_PATH: fixture.socketPath },
        1_000,
      );
      const created = JSON.parse(result.stdout) as { id: string; socketPath: string };
      expect(created.socketPath).toBe(fixture.socketPath);
      expect(result.exitCode).not.toBe(0);
      expect((await serverFor(fixture).snapshot()).sessions.exists({ id: created.id })).toBe(true);
    });
    expect(pid).toBeDefined();
    await waitForProcessExit(pid!);
    expect({ ...process.env }).toEqual(hostEnvironment);
  }, 30_000);
}
