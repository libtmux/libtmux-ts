import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { TmuxServerRestartedError, VersionTooLowError } from "../../src/errors.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";
import { Server } from "../../src/server.js";

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
    const failures = await Promise.all(
      Object.values(attempts).map((attempt) =>
        attempt().then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    for (const [index, name] of Object.keys(attempts).entries()) {
      expect(failures[index], name).toBeInstanceOf(VersionTooLowError);
    }

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

  refusal("is refused when it replaces an admitted daemon on the same socket", async () => {
    const { env, socket } = await endpoint();
    start("tmux", socket, env);
    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });
    expect(await server.hasSession("sentinel")).toBe(true);

    tmux("tmux", socket, env, "kill-server");
    for (let attempt = 0; attempt < 100 && existsSync(socket); attempt += 1) {
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
    const stale = await set();
    expect(stale).toBeInstanceOf(TmuxServerRestartedError);
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

describe("version admission", () => {
  test("fires neither after-display-message nor command-error", async () => {
    const { env, socket } = await endpoint();
    start("tmux", socket, env);
    const run = (...args: string[]) => tmux("tmux", socket, env, ...args);
    expect(run("set-hook", "-g", "after-display-message", "set -g @probe-display fired").code).toBe(
      0,
    );
    // `command-error` arrived in 3.5; older releases refuse the hook name.
    const hasCommandError =
      run("set-hook", "-g", "command-error", "set -g @probe-error fired").code === 0;

    const server = new Server({ environment: env, socketPath: socket, configFile: "/dev/null" });
    await server.version();
    await server.cmd("list-sessions");
    await server.hasSession("sentinel");

    expect(run("show-options", "-gqv", "@probe-display").out).toBe("");
    expect(run("show-options", "-gqv", "@probe-error").out).toBe("");

    // The hooks are live: ordinary commands do fire them.
    run("display-message", "-p", "x");
    expect(run("show-options", "-gqv", "@probe-display").out.trim()).toBe("fired");
    if (hasCommandError) {
      run("has-session", "-t", "=missing");
      expect(run("show-options", "-gqv", "@probe-error").out.trim()).toBe("fired");
    }
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
