import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { VersionTooLowError } from "../../src/errors.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";
import { Server } from "../../src/server.js";
import { testControl } from "../support/tmux_release.js";

/**
 * The supported client is `tmux` on PATH. A daemon below the floor is started
 * from `LIBTMUX_REJECTED_TMUX`, which the rejection lanes provide; elsewhere
 * those tests are skipped, and a lane that must run them sets
 * `LIBTMUX_REQUIRE_REJECTED` so a missing binary fails instead of skipping.
 */
const rejected = process.env.LIBTMUX_REJECTED_TMUX;
const required = process.env.LIBTMUX_REQUIRE_REJECTED === "1";
const refusal = rejected === undefined && !required ? test.skip : test;

const decoder = new TextDecoder();
const directories: string[] = [];
const daemons: { bin: string; socket: string; env: Record<string, string> }[] = [];

function environment(directory: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "", TMUX_TMPDIR: directory };
}

function tmux(bin: string, socket: string, env: Record<string, string>, ...args: string[]) {
  const done = spawnSync(bin, ["-S", socket, "-f", "/dev/null", ...args], { env });
  return {
    code: done.status,
    out: decoder.decode(done.stdout),
    err: decoder.decode(done.stderr),
  };
}

async function endpoint(): Promise<{
  directory: string;
  env: Record<string, string>;
  socket: string;
}> {
  const directory = await makeTestDirectory("ltx-core-minimum-");
  directories.push(directory);
  return { directory, env: environment(directory), socket: join(directory, "s") };
}

function start(bin: string, socket: string, env: Record<string, string>): void {
  const started = tmux(bin, socket, env, "new-session", "-d", "-s", "sentinel", "sh");
  expect(started.code).toBe(0);
  daemons.push({ bin, socket, env });
}

afterEach(async () => {
  for (const daemon of daemons.splice(0))
    tmux(daemon.bin, daemon.socket, daemon.env, "kill-server");
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("a daemon below the core floor", () => {
  test("the rejection lane provides the unsupported tmux", () => {
    if (required) expect(rejected).toBeDefined();
  });

  refusal("is refused by every entry point with no effect", async () => {
    const { env, socket } = await endpoint();
    start(rejected!, socket, env);
    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });

    const attempts: Record<string, () => Promise<unknown>> = {
      connect: () => server.connect(),
      cmd: () => server.cmd("new-session", ["-d", "-s", "effect"], { target: null }),
      hasSession: () => server.hasSession("sentinel"),
      isAlive: () => server.isAlive(),
      kill: () => server.kill(),
      newSession: () => server.newSession({ name: "effect", shellCommand: "sh" }),
      setBuffer: () => server.setBuffer("effect", "data"),
      snapshot: () => server.snapshot(),
      version: () => server.version(),
      watch: async () => {
        for await (const event of server.watch()) void event;
      },
    };
    const started = performance.now();
    const failures = await Promise.all(
      Object.values(attempts).map((attempt) =>
        attempt().then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    const elapsed = performance.now() - started;
    for (const [index, name] of Object.keys(attempts).entries()) {
      expect(failures[index], name).toBeInstanceOf(VersionTooLowError);
    }
    // A 3.0a or 3.1c daemon keeps the client's stdout open. A transport that
    // waited for end of file would refuse only when the command timeout fired.
    expect(elapsed).toBeLessThan(8_000);

    const after = tmux(rejected!, socket, env, "list-sessions", "-F", "#{session_name}");
    expect(after.out.trim()).toBe("sentinel");
    expect(tmux(rejected!, socket, env, "list-buffers").out).toBe("");
    expect(tmux(rejected!, socket, env, "list-clients").out).toBe("");
  });

  refusal("is refused even when the selected client reports a newer release", async () => {
    const { env, socket } = await endpoint();
    start(rejected!, socket, env);
    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });
    const client = spawnSync("tmux", ["-V"], { env });
    expect(client.status).toBe(0);

    await expect(server.newSession({ name: "effect" })).rejects.toBeInstanceOf(VersionTooLowError);
    expect(tmux(rejected!, socket, env, "list-sessions", "-F", "#{session_name}").out.trim()).toBe(
      "sentinel",
    );
  });

  refusal("is refused when it replaces a checked daemon on the same socket", async () => {
    const { env, socket } = await endpoint();
    start("tmux", socket, env);
    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });
    expect(await server.hasSession("sentinel")).toBe(true);

    tmux("tmux", socket, env, "kill-server");
    // The socket file stays behind after the daemon exits, so ask for a
    // connection: it is refused once the daemon is gone.
    for (
      let attempt = 0;
      attempt < 100 && tmux("tmux", socket, env, "list-sessions").code === 0;
      attempt += 1
    ) {
      // eslint-disable-next-line no-await-in-loop -- the wait is the loop.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    start(rejected!, socket, env);

    // The memory of the first daemon must not carry over to this one.
    const set = () =>
      server.cmd("set-option", ["-g", "@effect", "1"], { target: null }).then(
        () => undefined,
        (error: unknown) => error,
      );
    // The fence catches the replacement, and the refusal names why at once.
    const stale = await set();
    expect(stale).toBeInstanceOf(VersionTooLowError);
    expect(stale).toMatchObject({ delivery: "not_started" });
    expect(await set()).toBeInstanceOf(VersionTooLowError);
    expect(tmux(rejected!, socket, env, "show-options", "-gqv", "@effect").out).toBe("");
  });

  refusal("never starts a server through an unsupported executable", async () => {
    const { env, socket } = await endpoint();
    const server = new Server({
      environment: env,
      socketPath: socket,
      configFile: "/dev/null",
      tmuxBin: rejected!,
    });

    await expect(server.newSession({ name: "effect" })).rejects.toBeInstanceOf(VersionTooLowError);
    await expect(server.cmd("start-server", [], { target: null })).rejects.toBeInstanceOf(
      VersionTooLowError,
    );
    expect(existsSync(socket)).toBe(false);
  });
});

describe("version check", () => {
  /**
   * A daemon with both hooks set and a server that has read nothing from it.
   *
   * Each version-check path reads the version in its own place: the capability
   * binding, an ordinary command with a cold cache, the layout check, and the
   * control attach. A server per test keeps one path's answer from filling the
   * cache the next path would have used.
   */
  async function hooked() {
    const { env, socket } = await endpoint();
    start("tmux", socket, env);
    const run = (...args: string[]) => tmux("tmux", socket, env, ...args);
    // The commands the version read is built from, each with the command that
    // fires its hook. tmux refuses a hook name it does not have, and has no
    // `after-if-shell` or `after-run-shell`; `command-error` arrived in 3.5.
    const candidates: Record<string, readonly string[]> = {
      "after-display-message": ["display-message", "-p", "x"],
      "after-if-shell": ["if-shell", "-F", "1", ""],
      "after-run-shell": ["run-shell", "true"],
      "command-error": ["has-session", "-t", "=missing"],
    };
    const armed: string[] = [];
    const refused: Record<string, string> = {};
    for (const name of Object.keys(candidates)) {
      const set = run("set-hook", "-g", name, `set -g @probe-${name} fired`);
      if (set.code === 0) armed.push(name);
      else refused[name] = set.err;
    }
    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });
    const quiet = (): void => {
      for (const name of armed) {
        expect(run("show-options", "-gqv", `@probe-${name}`).out, name).toBe("");
      }
    };
    // Every armed hook is live: its own command does fire it.
    const live = (): void => {
      for (const name of armed) {
        run(...candidates[name]!);
        expect(run("show-options", "-gqv", `@probe-${name}`).out.trim(), name).toBe("fired");
      }
    };
    return { armed, live, quiet, refused, server };
  }

  test("each hook is armed or named invalid by tmux", async () => {
    const { armed, refused } = await hooked();
    expect(armed).toContain("after-display-message");
    for (const [name, message] of Object.entries(refused)) {
      expect(message, name).toContain("invalid option");
    }
  });

  test("the capability read fires neither after-display-message nor command-error", async () => {
    const { live, quiet, server } = await hooked();
    await server.version();
    quiet();
    live();
  });

  test("an ordinary command with a cold cache fires neither hook", async () => {
    const { live, quiet, server } = await hooked();
    await server.cmd("list-sessions");
    await server.hasSession("sentinel");
    quiet();
    live();
  });

  test("the layout check's read fires neither hook", async () => {
    const { live, quiet, server } = await hooked();
    // A mirrored preset is valid or not by release, so the daemon is asked.
    await server
      .validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }])
      .catch(() => undefined);
    quiet();
    live();
  });

  testControl("the control attach's read fires neither hook", async () => {
    const { live, quiet, server } = await hooked();
    // A failed attach fails the test: the read ran only if the attach did.
    await (await server.connect()).close();
    quiet();
    live();
  });

  test("serves the supported daemon with a sentinel intact", async () => {
    const { env, socket } = await endpoint();
    start("tmux", socket, env);
    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });

    expect(await server.hasSession("sentinel")).toBe(true);
    const created = await server.newSession({ name: "added", shellCommand: "sh" });
    expect(created.name).toBe("added");
    expect(await server.versionAtLeast("3.3a")).toBe(true);
  });
});
