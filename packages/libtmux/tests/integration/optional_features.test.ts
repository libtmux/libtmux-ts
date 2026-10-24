import { spawnSync } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { TmuxCommandError, TmuxTransportError, VersionTooLowError } from "../../src/errors.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";
import { Server } from "../../src/server.js";
import { controlSupported, tmuxAtLeast, tmuxRelease } from "../support/tmux_release.js";

/**
 * Each optional feature is refused below the release that makes it safe and
 * works from there on, on whichever tmux is on PATH. The refusal half is what
 * the older matrix lanes run; the working half is what the newer ones run.
 */
const decoder = new TextDecoder();
const directories: string[] = [];
const daemons: { socket: string; env: Record<string, string> }[] = [];

function tmux(socket: string, env: Record<string, string>, ...args: string[]) {
  const done = spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env });
  return { code: done.status, out: decoder.decode(done.stdout) };
}

async function fixture(): Promise<{ env: Record<string, string>; server: Server; socket: string }> {
  const directory = await makeTestDirectory("ltx-optional-features-");
  directories.push(directory);
  const env = { PATH: process.env.PATH ?? "", TMUX_TMPDIR: directory };
  const socket = join(directory, "s");
  expect(tmux(socket, env, "new-session", "-d", "-s", "sentinel", "sh").code).toBe(0);
  daemons.push({ env, socket });
  return {
    env,
    server: new Server({ environment: env, socketPath: socket, configFile: "/dev/null" }),
    socket,
  };
}

const failure = (attempt: () => Promise<unknown>): Promise<unknown> =>
  attempt().then(
    () => undefined,
    (error: unknown) => error,
  );

afterEach(async () => {
  for (const daemon of daemons.splice(0)) tmux(daemon.socket, daemon.env, "kill-server");
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("optional features on this tmux", () => {
  test("names the release under test", () => {
    expect(tmuxRelease).toBeDefined();
  });

  test("control mode attaches from 3.7 and is refused before any client attaches below it", async () => {
    const { env, server, socket } = await fixture();
    if (controlSupported) {
      await using live = await server.connect();
      expect((await live.snapshot()).sessions.count()).toBeGreaterThan(0);
      return;
    }
    expect(await failure(() => server.connect())).toBeInstanceOf(VersionTooLowError);
    expect(
      await failure(async () => {
        for await (const event of server.watch()) void event;
      }),
    ).toMatchObject({ criteriaName: "control mode", delivery: "not_started", since: "3.7" });
    expect(tmux(socket, env, "list-clients").out).toBe("");
    // The rest of the library still works there.
    expect((await server.snapshot()).sessions.count()).toBe(1);
  });

  test("control mode is refused for a daemon that reports a 3.7 candidate or development build", async () => {
    const { env, socket } = await fixture();
    // A client in front of the real tmux that rewrites the version it reports.
    const wrapper = join(directories.at(-1) ?? "", "report-version.sh");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        `v=$(tmux -V | cut -d' ' -f2 | sed 's/[.]/[.]/g')`,
        "out=$(mktemp); err=$(mktemp)",
        'tmux "$@" >"$out" 2>"$err"; rc=$?',
        'sed "s/$v/$REPORTED_VERSION/g" "$out"; sed "s/$v/$REPORTED_VERSION/g" "$err" >&2',
        'rm -f "$out" "$err"; exit $rc',
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o700);
    for (const reported of ["next-3.7", "3.7-rc2"]) {
      const server = new Server({
        environment: { ...env, REPORTED_VERSION: reported },
        socketPath: socket,
        tmuxBin: wrapper,
        configFile: "/dev/null",
      });
      // eslint-disable-next-line no-await-in-loop -- each build is checked against the same daemon.
      const refusal = await failure(() => server.connect());
      expect(refusal).toBeInstanceOf(VersionTooLowError);
      expect(refusal).toMatchObject({ criteriaName: "control mode", serverVersion: reported });
    }
    expect(tmux(socket, env, "list-clients").out).toBe("");
  });

  test("a command beside a control connection asks tmux for no client listing", async () => {
    const { env, server, socket } = await fixture();
    if (!controlSupported) return;
    expect(
      tmux(socket, env, "set-hook", "-g", "after-list-clients", "set -g @listed yes").code,
    ).toBe(0);
    await using live = await server.connect();
    await live.cmd("set-option", ["-g", "@beside", "1"], { target: null });
    // The attach and the command may not list clients to find the observer.
    expect(tmux(socket, env, "show-options", "-gqv", "@listed").out).toBe("");
    expect(tmux(socket, env, "show-options", "-gqv", "@beside").out.trim()).toBe("1");
    // The hook is live: a listing does fire it.
    tmux(socket, env, "list-clients");
    expect(tmux(socket, env, "show-options", "-gqv", "@listed").out.trim()).toBe("yes");
  });

  test("named buffers are deleted and renamed from 3.4, never by guesswork below it", async () => {
    const { env, server, socket } = await fixture();
    await server.setBuffer("keep", "kept");
    await server.setBuffer("target", "gone");
    if (tmuxAtLeast("3.4")) {
      await server.deleteBuffer("target");
      expect(tmux(socket, env, "list-buffers", "-F", "#{buffer_name}").out.trim()).toBe("keep");
      return;
    }
    const attempts = [
      () => server.deleteBuffer("target"),
      () => server.deleteBuffer("missing"),
      () => server.cmd("delete-buffer", ["-b", "missing"], { target: null }),
      () => server.cmd("set-buffer", ["-b", "target", "-n", "renamed"], { target: null }),
      () => server.cmd("setb", ["-b", "target", "-n", "renamed"], { target: null }),
    ];
    for (const attempt of attempts) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same server.
      expect(await failure(attempt)).toBeInstanceOf(VersionTooLowError);
    }
    const names = tmux(socket, env, "list-buffers", "-F", "#{buffer_name}").out.trim().split("\n");
    expect(names.sort()).toEqual(["keep", "target"]);
    // Paste-and-delete of a named buffer is exact on every release.
    expect(tmux(socket, env, "show-buffer", "-b", "keep").out).toBe("kept");
  });

  test("run-shell output is returned from 3.5 and refused on 3.3a and 3.4", async () => {
    const { server } = await fixture();
    if (tmuxAtLeast("3.5")) {
      expect((await server.runShell("echo captured")).join("\n")).toContain("captured");
      return;
    }
    expect(await failure(() => server.runShell("echo captured"))).toBeInstanceOf(
      VersionTooLowError,
    );
    // Running without the output stays available.
    await server.cmd("run-shell", ["true"], { target: null });
  });

  // With an attached xterm-256color client, 3.3a stops on refresh-client -l; the
  // refusal comes before dispatch, so the fixture needs no client.
  test("a clipboard query never reaches a tmux that stops on it", async () => {
    const { server } = await fixture();
    if (tmuxAtLeast("3.4")) {
      // With no client attached tmux reports that there is no current client.
      expect(
        await failure(() => server.cmd("refresh-client", ["-l"], { target: null })),
      ).toBeInstanceOf(TmuxCommandError);
      return;
    }
    for (const name of ["refresh-client", "refresh", "refresh-c"]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same server.
      expect(await failure(() => server.cmd(name, ["-l"], { target: null }))).toBeInstanceOf(
        VersionTooLowError,
      );
    }
    expect(await server.isAlive()).toBe(true);
  });

  test("an unreadable layout never reaches a tmux that crashes on it", async () => {
    const { server } = await fixture();
    if (tmuxAtLeast("3.4")) {
      await server.cmd("select-layout", ["-t", "=sentinel:", "tiled"], { target: null });
      return;
    }
    const refusals = await Promise.all(
      ["garbage", "not-a-preset", "{ }"].map((layout) =>
        failure(() => server.cmd("select-layout", ["-t", "=sentinel:", layout], { target: null })),
      ),
    );
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(TmuxTransportError);
    expect(await server.isAlive()).toBe(true);
    await server.cmd("select-layout", ["-t", "=sentinel:", "tile"], { target: null });
  });

  test("tmux 3.7's name and break-pane faults are refused before dispatch", async () => {
    const { env, server, socket } = await fixture();
    const sessions = (): string[] =>
      tmux(socket, env, "list-sessions", "-F", "#{session_name}").out.trim().split("\n").sort();
    if (tmuxRelease === "3.7") {
      const refused = [
        () => server.cmd("new-session", ["-d", "-s", "dotted.name"], { target: null }),
        () => server.cmd("new-window", ["-d", "-n", "colon:name"], { target: null }),
        () => server.cmd("rename-session", ["-t", "=sentinel", "x.y"], { target: null }),
        () => server.cmd("break-pane", ["-d", "-n", "named"], { target: null }),
      ];
      for (const attempt of refused) {
        // eslint-disable-next-line no-await-in-loop -- each is checked against the same server.
        expect(await failure(attempt)).toBeInstanceOf(TmuxTransportError);
      }
      expect(sessions()).toEqual(["sentinel"]);
    }
    // A plain name works everywhere.
    await server.cmd("new-session", ["-d", "-s", "plain"], { target: null });
    expect(sessions()).toEqual(["plain", "sentinel"]);
  });

  test("a break-pane with no name never reaches tmux 3.7, which exits on it", async () => {
    const { server } = await fixture();
    const pane = (await server.snapshot()).panes.one();
    const first = await pane.split();
    if (tmuxRelease === "3.7") {
      expect(
        await failure(() => server.cmd("break-pane", ["-d", "-s", first.id], { target: null })),
      ).toBeInstanceOf(TmuxTransportError);
      expect(await failure(() => first.breakOut())).toBeInstanceOf(TmuxTransportError);
      expect(await server.isAlive()).toBe(true);
      // The named form is repaired and still works.
      await first.breakOut("kept");
      expect(await server.isAlive()).toBe(true);
      return;
    }
    await first.breakOut();
    expect(await server.isAlive()).toBe(true);
  });

  test("split-window encodes sizes as percentages", async () => {
    const { server } = await fixture();
    const pane = (await server.snapshot()).panes.one();
    const split = await pane.split({ size: "40%" });
    expect(split.id).not.toBe(pane.id);
    if (tmuxRelease === "3.4") {
      expect(
        await failure(() => server.cmd("split-window", ["-d", "-p", "40"], { target: pane.id })),
      ).toBeInstanceOf(TmuxTransportError);
    }
  });
});
