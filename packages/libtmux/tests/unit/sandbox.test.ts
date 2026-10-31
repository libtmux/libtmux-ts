import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  assertSandboxed,
  enterSandbox,
  makeTestDirectory,
  SANDBOX_ENV,
  SANDBOX_SOCKET_LIMIT,
  sandboxFindings,
  tmuxSocketFor,
  type Sandbox,
  type SandboxOptions,
} from "../../src/_internal/test/testkit.js";

const NAMED: string[] = ["TMUX", "TMUX_PANE", "LIBTMUX_SOCKET", "LIBTMUX_SOCKET_PATH"];

/** What a developer's shell inside tmux holds, none of it real. */
function ambient(): Record<string, string | undefined> {
  return {
    LIBTMUX_SOCKET: "theirs",
    LIBTMUX_SOCKET_PATH: "/nowhere/theirs.sock",
    PATH: "/usr/bin",
    TMUX: "/nowhere/theirs.sock,1,0",
    TMUX_PANE: "%7",
    TMUX_TMPDIR: "/nowhere",
  };
}

const entered: Sandbox[] = [];

async function enter(
  environment: Record<string, string | undefined>,
  options?: SandboxOptions,
): Promise<Sandbox> {
  const sandbox = await enterSandbox(environment, options);
  entered.push(sandbox);
  return sandbox;
}

const scratch: string[] = [];
const servers: ChildProcess[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  await Promise.all(entered.splice(0).map((sandbox) => sandbox.release().catch(() => undefined)));
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

/** A real, owner-only directory whose default socket path is over tmux's limit. */
async function longDirectory(): Promise<string> {
  return makeTestDirectory(`ltx-long-${"x".repeat(SANDBOX_SOCKET_LIMIT)}-`);
}

describe("tmuxSocketFor", () => {
  test("takes the first field of a TMUX that names a socket", () => {
    expect(tmuxSocketFor({ TMUX: "/a/b.sock,12,3", TMUX_TMPDIR: "/ignored" }, 7)).toBe("/a/b.sock");
  });

  test.each(["", ",1,0"])("falls back to TMUX_TMPDIR when TMUX is %j", (value) => {
    expect(tmuxSocketFor({ TMUX: value, TMUX_TMPDIR: "/private" }, 7)).toBe(
      "/private/tmux-7/default",
    );
  });

  test.each([undefined, ""])("uses /tmp when TMUX_TMPDIR is %j", (value) => {
    expect(tmuxSocketFor({ TMUX_TMPDIR: value }, 7)).toBe("/tmp/tmux-7/default");
  });
});

describe("enterSandbox", () => {
  test("replaces every variable that names another server", async () => {
    const environment = ambient();
    const sandbox = await enter(environment);

    for (const name of NAMED) expect(environment[name]).toBeUndefined();
    expect(environment["PATH"]).toBe("/usr/bin");
    expect(environment["TMUX_TMPDIR"] === sandbox.root).toBe(true);
    expect(environment[SANDBOX_ENV] === sandbox.root).toBe(true);
    expect(dirname(sandbox.root) === tmpdir()).toBe(true);
    expect(basename(sandbox.root).startsWith("ltx-sandbox-")).toBe(true);
    expect(statSync(sandbox.root).mode & 0o777).toBe(0o700);
    expect(sandboxFindings(environment)).toEqual([]);
    expect(tmuxSocketFor(environment).startsWith(`${sandbox.root}/`)).toBe(true);
  });

  test("lets a child join the sandbox, which only its maker removes", async () => {
    const environment = ambient();
    const owner = await enter(environment);
    const joined = await enter(environment);

    expect(joined.root === owner.root).toBe(true);
    await joined.release();
    expect(existsSync(owner.root)).toBe(true);
    await owner.release();
    expect(existsSync(owner.root)).toBe(false);
    await owner.release();
  });

  test("refuses a temporary directory with no room for a socket, and leaves nothing behind", async () => {
    const parent = await longDirectory();
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = parent;
    try {
      await expect(enterSandbox({})).rejects.toThrow(`over ${String(SANDBOX_SOCKET_LIMIT)} bytes`);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
      await rm(parent, { force: true, recursive: true });
    }
  });

  test("names no value when TMPDIR cannot hold a sandbox", async () => {
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = join(tmpdir(), "ltx-absent-parent", "child");
    try {
      const failure = await enterSandbox({}).then(
        () => "",
        (error: unknown) => String(error),
      );

      expect(failure).toContain("TMPDIR does not name a directory a sandbox can be made in");
      expect(failure.includes("ltx-absent-parent")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
    }
  });

  test("enters a sandbox of its own once the last one is released", async () => {
    const environment = ambient();
    const first = await enter(environment);
    await first.release();

    expect(existsSync(first.root)).toBe(false);
    expect(sandboxFindings(environment)).toContain(
      `${SANDBOX_ENV} does not name a sandbox directory`,
    );

    const second = await enter(environment);

    expect(second.root === first.root).toBe(false);
    expect(sandboxFindings(environment)).toEqual([]);
  });

  test("refuses a sandbox that something has since made ambient again", async () => {
    const environment = ambient();
    await enter(environment);
    environment["TMUX"] = "/nowhere/theirs.sock,1,0";

    await expect(enterSandbox(environment)).rejects.toThrow("TMUX is set");
  });
});

describe("sandboxFindings", () => {
  test.each(NAMED)("reports %s set, even empty", async (name) => {
    const environment = ambient();
    await enter(environment);
    environment[name] = "";

    expect(sandboxFindings(environment)).toEqual([`${name} is set`]);
    expect(() => assertSandboxed(environment)).toThrow(`${name} is set`);
  });

  test("reports an environment that never entered one", () => {
    expect(sandboxFindings(ambient())).toEqual([
      "TMUX is set",
      "TMUX_PANE is set",
      "LIBTMUX_SOCKET is set",
      "LIBTMUX_SOCKET_PATH is set",
      `${SANDBOX_ENV} does not name a sandbox directory`,
    ]);
    expect(sandboxFindings({ TMUX_TMPDIR: "/private", [SANDBOX_ENV]: "relative" })).toEqual([
      `${SANDBOX_ENV} does not name a sandbox directory`,
    ]);
  });

  test("reports a TMUX_TMPDIR that has left the sandbox", async () => {
    const environment = ambient();
    await enter(environment);
    environment["TMUX_TMPDIR"] = "/nowhere";

    expect(sandboxFindings(environment)).toEqual([
      "TMUX_TMPDIR is not the sandbox",
      "a tmux command with no socket would use a socket outside the sandbox",
    ]);
  });

  test("reports a default socket over the limit, naming the limit and not the path", async () => {
    const root = await longDirectory();
    try {
      const findings = sandboxFindings({ TMUX_TMPDIR: root, [SANDBOX_ENV]: root });

      expect(findings).toEqual([
        `the default socket path is over ${String(SANDBOX_SOCKET_LIMIT)} bytes; use a shorter TMPDIR`,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports a directory that is missing, shared, or not a directory", async () => {
    const environment = ambient();
    const sandbox = await enter(environment);

    await chmod(sandbox.root, 0o755);
    expect(sandboxFindings(environment)).toEqual(["the sandbox is not owner-only"]);

    await chmod(sandbox.root, 0o700);
    await rm(sandbox.root, { recursive: true });
    expect(sandboxFindings(environment)).toEqual(["the sandbox directory is missing"]);

    await symlink(tmpdir(), sandbox.root);
    expect(sandboxFindings(environment)).toEqual(["the sandbox is not a directory"]);
    await rm(sandbox.root);
  });
});

describe("assertSandboxed", () => {
  test("returns the sandbox root, and names the remedy when it refuses", async () => {
    const environment = ambient();
    const sandbox = await enter(environment);
    expect(assertSandboxed(environment) === sandbox.root).toBe(true);

    expect(() => assertSandboxed(ambient())).toThrow(
      "refusing to run outside the tmux sandbox: TMUX is set",
    );
    expect(() => assertSandboxed(ambient())).toThrow("bunfig.toml");
  });

  test("names variables and never prints what they hold", async () => {
    const environment = ambient();
    await enter(environment);
    environment["TMUX"] = "/secret/place.sock,1,0";
    let message = "";
    try {
      assertSandboxed(environment);
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("TMUX is set");
    expect(message).toContain("outside the sandbox");
    expect(message.includes("/secret/place.sock")).toBe(false);
  });
});

/** A tmux whose every command runs `script`, which is handed `-S <socket> kill-server`. */
async function tmuxRunning(script: string): Promise<string> {
  const directory = await makeTestDirectory("ltx-fake-tmux-");
  scratch.push(directory);
  const path = join(directory, "tmux");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

// The argument after -S is the socket; its server wrote its pid beside it.
const STOPS = 'kill "$(cat "$2.pid")"';
const STOPS_SLOWLY = `( sleep 0.5; ${STOPS} ) >/dev/null 2>&1 &`;

/** A process listening where tmux would, so that stopping it is a real act. */
async function serverOn(socketPath: string): Promise<ChildProcess> {
  await mkdir(dirname(socketPath), { recursive: true });
  const server = spawn(
    process.execPath,
    [
      "-e",
      'require("node:fs").writeFileSync(process.env.SOCKET + ".pid", String(process.pid)); require("node:net").createServer().listen(process.env.SOCKET);',
    ],
    { env: { SOCKET: socketPath }, stdio: "ignore" },
  );
  servers.push(server);
  for (let attempt = 0; attempt < 200 && !existsSync(socketPath); attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling one file until the server has made it.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return server;
}

const uid = String(process.getuid?.() ?? 0);

/** Whether a process is gone, zombie included, which only collecting its status achieves. */
async function vanishes(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop -- polling one process until it is gone.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** What release says, or the empty string when it says nothing. */
async function released(sandbox: Sandbox): Promise<string> {
  try {
    await sandbox.release();
  } catch (error) {
    return String(error);
  }
  return "";
}

/** A socket file whose server died without unlinking it, which is how a stopped tmux leaves one. */
async function deadSocketAt(socketPath: string): Promise<void> {
  const dying = spawn(
    process.execPath,
    [
      "-e",
      'require("node:net").createServer().listen(process.env.SOCKET, () => process.kill(process.pid, "SIGKILL"));',
    ],
    { env: { SOCKET: socketPath }, stdio: "ignore" },
  );
  await new Promise((resolve) => dying.once("exit", resolve));
}

/**
 * A connect that fails with ENOENT, as Bun 1.3 does for any failure, after `prepare` has run;
 * `calls` counts the connects made, so a test can tell the stand-in was the one used.
 */
function enoent(prepare: (path: string) => void = () => undefined): {
  readonly calls: () => number;
  readonly connect: (path: string) => Socket;
} {
  let calls = 0;
  return {
    calls: () => calls,
    connect: (path) => {
      calls += 1;
      prepare(path);
      const socket = new Socket();
      setImmediate(() =>
        socket.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      );
      return socket;
    },
  };
}

describe("leaving the sandbox", () => {
  test("stops a server a test left on the default socket, and fails naming the socket", async () => {
    const sandbox = await enter(ambient(), { settleMs: 1_000, tmux: await tmuxRunning(STOPS) });
    await serverOn(join(sandbox.root, `tmux-${uid}`, "default"));

    expect(await released(sandbox)).toContain(
      `a server was left running on the sandbox's "tmux-${uid}/default" socket and had to be stopped`,
    );
    expect(existsSync(sandbox.root)).toBe(false);
    await expect(sandbox.release()).resolves.toBeUndefined();
  });

  test("finds a server wherever the test put its socket", async () => {
    const sandbox = await enter(ambient(), { settleMs: 1_000, tmux: await tmuxRunning(STOPS) });
    await serverOn(join(sandbox.root, "custom.sock"));
    await serverOn(join(sandbox.root, "deep", "er", "custom.sock"));

    const message = await released(sandbox);

    expect(message).toContain('on the sandbox\'s "custom.sock" socket and had to be stopped');
    expect(message).toContain('"deep/er/custom.sock" socket and had to be stopped');
    expect(existsSync(sandbox.root)).toBe(false);
  });

  test("waits for a server that is slow to stop", async () => {
    const sandbox = await enter(ambient(), {
      settleMs: 3_000,
      tmux: await tmuxRunning(STOPS_SLOWLY),
    });
    await serverOn(join(sandbox.root, "custom.sock"));

    expect(await released(sandbox)).toContain("had to be stopped");
    expect(existsSync(sandbox.root)).toBe(false);
  });

  test("makes a second release wait for the one under way, and report no failure of its own", async () => {
    const sandbox = await enter(ambient(), {
      settleMs: 3_000,
      tmux: await tmuxRunning(STOPS_SLOWLY),
    });
    await serverOn(join(sandbox.root, "custom.sock"));

    const first = released(sandbox);
    const second = released(sandbox).then((message) => ({
      message,
      present: existsSync(sandbox.root),
    }));

    expect(await second).toEqual({ message: "", present: false });
    expect(await first).toContain("had to be stopped");
  });

  test("keeps the sandbox and fails when a socket cannot be probed, since a server may still answer", async () => {
    const sandbox = await enter(ambient(), { settleMs: 300, tmux: await tmuxRunning("exit 0") });
    const server = await serverOn(join(sandbox.root, "custom.sock"));
    // Not a refusal and not a missing socket: connecting is not allowed, which says nothing.
    await chmod(join(sandbox.root, "custom.sock"), 0o000);

    const message = await released(sandbox);

    expect(message).toContain('"custom.sock" socket could not be stopped');
    expect(message).toContain(`${basename(sandbox.root)} was kept`);
    server.kill("SIGKILL");
    await rm(sandbox.root, { force: true, recursive: true });
  });

  test("fails fast and names the call when kill-server never returns, leaving no process behind", async () => {
    const pids = join(await makeTestDirectory("ltx-pids-"), "pid");
    scratch.push(join(pids, ".."));
    const stub = await tmuxRunning(
      `echo $$ > "${pids}.child"; sleep 600 & echo $! > "${pids}.grandchild"; wait`,
    );
    const sandbox = await enter(ambient(), { deadlineMs: 600, settleMs: 300, tmux: stub });
    const server = await serverOn(join(sandbox.root, "custom.sock"));
    const started = performance.now();
    let last = started;
    let longestGap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 10);

    const message = await released(sandbox);
    clearInterval(timer);

    expect(performance.now() - started).toBeLessThan(4_000);
    // The loop was never blocked for the call's deadline, as a synchronous wait would.
    expect(longestGap).toBeLessThan(400);
    expect(message).toContain(
      'kill-server on the sandbox\'s "custom.sock" socket did not return within 600 ms',
    );
    expect(message).toContain(`${basename(sandbox.root)} was kept`);
    const gone = await Promise.all(
      ["child", "grandchild"].map(async (which) =>
        vanishes(Number(await readFile(`${pids}.${which}`, "utf8"))),
      ),
    );
    expect(gone).toEqual([true, true]);
    server.kill("SIGKILL");
    await rm(sandbox.root, { force: true, recursive: true });
  });

  test("stops going on once its time is up, and keeps the sandbox", async () => {
    const sandbox = await enter(ambient(), { releaseMs: 0, tmux: await tmuxRunning("exit 0") });
    const server = await serverOn(join(sandbox.root, "custom.sock"));

    const message = await released(sandbox);

    expect(message).toContain(
      'the release ran out of time before it reached the sandbox\'s "custom.sock" socket',
    );
    expect(message).toContain(`${basename(sandbox.root)} was kept`);
    server.kill("SIGKILL");
    await rm(sandbox.root, { force: true, recursive: true });
  });

  test.each([
    ["kill-server does nothing", "exit 0"],
    ["kill-server fails, as it does across a version mismatch", "exit 1"],
  ])("keeps the sandbox and fails when %s to a server that answers", async (_name, script) => {
    const sandbox = await enter(ambient(), { settleMs: 300, tmux: await tmuxRunning(script) });
    const server = await serverOn(join(sandbox.root, "custom.sock"));

    const message = await released(sandbox);

    expect(message).toContain(
      'a server on the sandbox\'s "custom.sock" socket could not be stopped',
    );
    expect(message).toContain(`${basename(sandbox.root)} was kept`);
    expect(message.includes(sandbox.root)).toBe(false);
    expect(existsSync(join(sandbox.root, "custom.sock"))).toBe(true);
    server.kill("SIGKILL");
    await rm(sandbox.root, { force: true, recursive: true });
  });

  test("keeps the event loop running while it waits", async () => {
    const sandbox = await enter(ambient(), { settleMs: 1_000, tmux: await tmuxRunning("exit 0") });
    const server = await serverOn(join(sandbox.root, "custom.sock"));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);

    await released(sandbox);
    clearInterval(timer);

    // A second of waiting is a hundred ticks; a release that blocked would let few through.
    expect(ticks).toBeGreaterThan(30);
    server.kill("SIGKILL");
    await rm(sandbox.root, { force: true, recursive: true });
  });

  test("releases a dead socket cleanly when there is no tmux to run", async () => {
    const sandbox = await enter(ambient(), { settleMs: 300, tmux: "/nonexistent/ltx-tmux" });
    const directory = join(sandbox.root, `tmux-${uid}`);
    await mkdir(directory);
    await deadSocketAt(join(directory, "default"));

    expect(await released(sandbox)).toBe("");
    expect(existsSync(sandbox.root)).toBe(false);
  });

  test("kills no process group once its call has ended", async () => {
    const kills: number[] = [];
    const kill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0) kills.push(pid);
      return kill(pid, signal);
    }) as typeof process.kill;
    try {
      const sandbox = await enter(ambient(), {
        deadlineMs: 200,
        settleMs: 100,
        tmux: await tmuxRunning("exit 0"),
      });
      const server = await serverOn(join(sandbox.root, "custom.sock"));
      await released(sandbox);
      // Past the call's deadline, a timer that was not cleared would fire.
      await new Promise((resolve) => setTimeout(resolve, 500));
      server.kill("SIGKILL");
      await rm(sandbox.root, { force: true, recursive: true });
    } finally {
      process.kill = kill;
    }

    expect(kills).toEqual([]);
  });

  test("lets go of a socket file whose connect says ENOENT but that can be written, which is a refusal", async () => {
    const stub = enoent();
    const sandbox = await enter(ambient(), {
      connect: stub.connect,
      settleMs: 300,
      tmux: await tmuxRunning("exit 1"),
    });
    await deadSocketAt(join(sandbox.root, "custom.sock"));

    expect(await released(sandbox)).toBe("");
    expect(existsSync(sandbox.root)).toBe(false);
    expect(stub.calls()).toBeGreaterThan(0);
  });

  // Root can write a mode 000 file, so there the socket reads as a refusal.
  test.skipIf(process.getuid?.() === 0)(
    "keeps the sandbox over a socket file whose connect says ENOENT but that cannot be written, since it says nothing",
    async () => {
      const stub = enoent();
      const sandbox = await enter(ambient(), {
        connect: stub.connect,
        settleMs: 300,
        tmux: await tmuxRunning("exit 0"),
      });
      await deadSocketAt(join(sandbox.root, "custom.sock"));
      await chmod(join(sandbox.root, "custom.sock"), 0o000);

      const message = await released(sandbox);

      expect(message).toContain('"custom.sock" socket could not be stopped');
      expect(message).toContain(`${basename(sandbox.root)} was kept`);
      expect(stub.calls()).toBeGreaterThan(0);
      await rm(sandbox.root, { force: true, recursive: true });
    },
  );

  test("lets go of a socket whose connect says ENOENT because the file is gone", async () => {
    const stub = enoent((path) => rmSync(path, { force: true }));
    const sandbox = await enter(ambient(), {
      connect: stub.connect,
      settleMs: 300,
      tmux: await tmuxRunning("exit 1"),
    });
    await deadSocketAt(join(sandbox.root, "custom.sock"));

    expect(await released(sandbox)).toBe("");
    expect(existsSync(sandbox.root)).toBe(false);
    expect(stub.calls()).toBeGreaterThan(0);
  });

  // Root searches any directory, so there the file can still be looked at.
  test.skipIf(process.getuid?.() === 0)(
    "keeps the sandbox over a socket whose connect says ENOENT when the file cannot be looked at",
    async () => {
      let root = "";
      const stub = enoent(() => chmodSync(root, 0o000));
      const sandbox = await enter(ambient(), {
        connect: stub.connect,
        settleMs: 300,
        tmux: await tmuxRunning("exit 0"),
      });
      root = sandbox.root;
      await deadSocketAt(join(root, "custom.sock"));

      const message = await released(sandbox);
      chmodSync(root, 0o700);

      expect(message).toContain('"custom.sock" socket could not be stopped');
      expect(message).toContain(`${basename(root)} was kept`);
      expect(stub.calls()).toBeGreaterThan(0);
      await rm(root, { force: true, recursive: true });
    },
  );

  test("lets a socket go that nothing listens on", async () => {
    const sandbox = await enter(ambient(), { settleMs: 300, tmux: await tmuxRunning("exit 1") });
    const directory = join(sandbox.root, `tmux-${uid}`);
    await mkdir(directory);
    await deadSocketAt(join(directory, "default"));
    expect(existsSync(join(directory, "default"))).toBe(true);

    expect(await released(sandbox)).toBe("");
    expect(existsSync(sandbox.root)).toBe(false);
  });

  test("follows no link out of the sandbox", async () => {
    const outside = await makeTestDirectory("ltx-outside-");
    scratch.push(outside);
    const server = await serverOn(join(outside, "theirs.sock"));
    const sandbox = await enter(ambient(), { settleMs: 300, tmux: await tmuxRunning(STOPS) });
    await symlink(outside, join(sandbox.root, "link"));
    await symlink(outside, join(sandbox.root, `tmux-${uid}`));

    expect(await released(sandbox)).toBe("");

    expect(existsSync(sandbox.root)).toBe(false);
    expect(existsSync(join(outside, "theirs.sock"))).toBe(true);
    expect(server.exitCode).toBeNull();
  });

  test("names sockets and never prints a path", async () => {
    const sandbox = await enter(ambient(), { settleMs: 1_000, tmux: await tmuxRunning(STOPS) });
    await serverOn(join(sandbox.root, "custom.sock"));

    const message = await released(sandbox);

    expect(message).toContain("A test that starts a server must kill it");
    expect(message.includes(sandbox.root)).toBe(false);
  });
});
