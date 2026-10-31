import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  deadlineMs,
  makeTestDirectory,
  readProcessIdentity,
  resolveControllerIdentity,
} from "../../src/_internal/test/testkit.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const supervise = fileURLToPath(new URL("../fixtures/supervise.ts", import.meta.url));
const leaks = fileURLToPath(new URL("../fixtures/leaks_a_server.ts", import.meta.url));
const uid = String(process.getuid?.() ?? 0);

/** A run started from outside any sandbox, which is how a person starts one. */
const outside = (): Record<string, string | undefined> => ({
  HOME: process.env["HOME"],
  PATH: process.env["PATH"],
  TMPDIR: tmpdir(),
});

function leakedPid(output: string): number {
  return Number(/leaked-server-pid (\d+)/u.exec(output)?.[1]);
}

async function isGone(pid: number): Promise<boolean> {
  const deadline = performance.now() + deadlineMs(5_000);
  let alive = true;
  while (alive && performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling one process until it is gone.
    alive = (await readProcessIdentity(pid)) !== undefined;
    // eslint-disable-next-line no-await-in-loop -- as above.
    if (alive) await sleep(10);
  }
  return !alive;
}

/** A test that starts a server on a socket of its own and waits, to be interrupted. */
const WAITS_SOURCE = `import { spawnSync } from "node:child_process";
import { test } from "bun:test";

test("starts a server in the sandbox and waits", async () => {
  const started = spawnSync(
    "tmux",
    ["-S", \`\${process.env["TMUX_TMPDIR"]}/custom.sock\`, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pid}", "sleep 600"],
    { encoding: "utf8" },
  );
  process.stdout.write(\`sandbox-root \${process.env["TMUX_TMPDIR"]}\\nleaked-server-pid \${started.stdout.trim()}\\n\`);
  await new Promise(() => undefined);
}, 120_000);
`;

const SOCKETS: readonly [string, string, string][] = [
  ["the default socket", "default", `tmux-${uid}/default`],
  ["a socket of its own choosing", "custom", "custom.sock"],
];

describe("a supervised run", () => {
  test("passes when it leaves nothing behind", () => {
    const finished = spawnSync(process.execPath, [supervise, "-e", "0"], {
      encoding: "utf8",
      env: outside(),
    });

    expect(finished.status).toBe(0);
    expect(`${finished.stdout}${finished.stderr}`).not.toContain("left tmux running");
  });

  test.each(SOCKETS)(
    "fails when a test left a server on %s, and the server is gone",
    async (_where, mode, name) => {
      const finished = spawnSync(process.execPath, [supervise, leaks, mode], {
        encoding: "utf8",
        env: outside(),
      });
      const output = `${finished.stdout}${finished.stderr}`;

      expect(finished.status).not.toBe(0);
      expect(output).toContain("test cleanup failed");
      expect(output).toContain(
        `a server was left running on the sandbox's "${name}" socket and had to be stopped`,
      );
      expect(await isGone(leakedPid(output))).toBe(true);
    },
  );
  test("a signal during the release neither waits on a closed child nor reports one late", async () => {
    const real = (await resolveControllerIdentity("tmux")).executablePath;
    const bin = await makeTestDirectory("ltx-slow-kill-");
    await writeFile(
      join(bin, "tmux"),
      `#!/bin/sh\ncase " $* " in *" kill-server "*) sleep 3 ;; esac\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [supervise, leaks, "custom"], {
      env: { ...outside(), PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const deadline = performance.now() + deadlineMs(20_000);
    while (!/leaked-server-pid \d+/u.test(output) && performance.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- polling one child's output until its server is up.
      await sleep(50);
    }
    // The child has gone and the release is stalled in its slow kill-server.
    await sleep(800);
    const exited = new Promise<readonly [number | null, string | null]>((resolve) =>
      child.once("exit", (code, signal) => resolve([code, signal])),
    );

    child.kill("SIGTERM");
    const [code, signal] = await exited;

    // The signal still ends the supervisor, though its child has already closed.
    expect(signal === "SIGTERM" || code === 143).toBe(true);
    expect(output).not.toContain("close exceeded hard deadline");
    expect(await isGone(leakedPid(output))).toBe(true);
    await rm(bin, { force: true, recursive: true });
  }, 60_000);
});

describe("a script that never releases", () => {
  const never = fileURLToPath(new URL("../fixtures/never_releases.ts", import.meta.url));

  async function exitOf(
    argument: string,
  ): Promise<{ output: string; root: string; status: unknown }> {
    const child = spawn(process.execPath, [never, argument], {
      env: outside(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const status = await new Promise((resolve) => child.once("exit", resolve));
    return { output, root: /sandbox-root (\S+)/u.exec(output)?.[1] ?? "", status };
  }

  test("exits non-zero, stops a running server without waiting, and keeps the directory", async () => {
    const { output, root, status } = await exitOf("running");

    expect(status).toBe(1);
    expect(output).toContain("never released it");
    expect(await isGone(leakedPid(output))).toBe(true);
    expect(root === "").toBe(false);
    expect(existsSync(root)).toBe(true);
    await rm(root, { force: true, recursive: true });
  });

  test("keeps the directory over a running server whose socket path holds a space", async () => {
    const { output, root, status } = await exitOf("spaced");

    expect(status).toBe(1);
    expect(output).toContain("never released it");
    expect(await isGone(leakedPid(output))).toBe(true);
    expect(existsSync(root)).toBe(true);
    await rm(root, { force: true, recursive: true });
  });

  // The table of listening sockets is Linux's; elsewhere a socket is taken to listen.
  test.skipIf(process.platform !== "linux")(
    "exits zero and removes the directory when only a dead server's socket is left",
    async () => {
      const { output, root, status } = await exitOf("stale");

      expect(status).toBe(0);
      expect(output).not.toContain("never released it");
      expect(root === "").toBe(false);
      expect(existsSync(root)).toBe(false);
    },
  );
});

describe("a bare `bun test`", () => {
  let directory = "";

  beforeAll(async () => {
    directory = await makeTestDirectory("ltx-bare-");
    await writeFile(
      join(directory, "leak.test.ts"),
      `import { spawnSync } from "node:child_process";
import { test } from "bun:test";

test("starts a server on a socket of its own and never kills it", () => {
  const started = spawnSync(
    "tmux",
    ["-S", \`\${process.env["TMUX_TMPDIR"]}/custom.sock\`, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pid}", "sleep 600"],
    { encoding: "utf8" },
  );
  process.stdout.write(\`leaked-server-pid \${started.stdout.trim()}\\nsandbox-root \${process.env["TMUX_TMPDIR"]}\\n\`);
});
`,
    );
  });

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("fails when a test left a server in the sandbox its preload made, and the server is gone", async () => {
    const finished = spawnSync(process.execPath, ["test", join(directory, "leak.test.ts")], {
      cwd: packageRoot,
      encoding: "utf8",
      env: outside(),
    });
    const output = `${finished.stdout}${finished.stderr}`;

    expect(finished.status).not.toBe(0);
    expect(output).toContain("1 pass");
    expect(output).toContain(`"custom.sock" socket and had to be stopped`);
    expect(await isGone(leakedPid(output))).toBe(true);
  });

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s releases the sandbox its preload made, and stops the server in it",
    async (signal) => {
      await writeFile(join(directory, "waits.test.ts"), WAITS_SOURCE);
      const child = spawn(process.execPath, ["test", join(directory, "waits.test.ts")], {
        cwd: packageRoot,
        env: outside(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const deadline = performance.now() + deadlineMs(20_000);
      while (!/leaked-server-pid \d+/u.test(output) && performance.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- polling one child's output until its server is up.
        await sleep(50);
      }
      const root = /sandbox-root (\S+)/u.exec(output)?.[1] ?? "";
      const exited = new Promise((resolve) => child.once("exit", resolve));

      child.kill(signal);
      await exited;

      expect(root === "").toBe(false);
      expect(existsSync(root)).toBe(false);
      expect(await isGone(leakedPid(output))).toBe(true);
    },
    60_000,
  );
  test("a signal during a release that cannot stop the server still names it", async () => {
    await writeFile(join(directory, "waits.test.ts"), WAITS_SOURCE);
    const bin = join(directory, "inert-bin");
    await mkdir(bin, { recursive: true });
    // A kill-server that succeeds and stops nothing, as across a version mismatch.
    await writeFile(
      join(bin, "tmux"),
      `#!/bin/sh\ncase " $* " in *" kill-server "*) exit 0 ;; esac\nexec "${(await resolveControllerIdentity("tmux")).executablePath}" "$@"\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ["test", join(directory, "waits.test.ts")], {
      cwd: packageRoot,
      env: { ...outside(), PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const deadline = performance.now() + deadlineMs(20_000);
    while (!/leaked-server-pid \d+/u.test(output) && performance.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- polling one child's output until its server is up.
      await sleep(50);
    }
    const root = /sandbox-root (\S+)/u.exec(output)?.[1] ?? "";
    const exited = new Promise((resolve) => child.once("exit", resolve));

    child.kill("SIGINT");
    await exited;

    expect(output).toContain(`"custom.sock" socket could not be stopped`);
    // Nothing stopped the server, which is the point; stop it here.
    process.kill(leakedPid(output));
    await rm(root, { force: true, recursive: true });
  }, 60_000);

  test("a signal during the release waits for it and still removes the sandbox", async () => {
    const real = (await resolveControllerIdentity("tmux")).executablePath;
    const bin = join(directory, "slow-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "tmux"),
      `#!/bin/sh\ncase " $* " in *" kill-server "*) sleep 3 ;; esac\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ["test", join(directory, "leak.test.ts")], {
      cwd: packageRoot,
      env: { ...outside(), PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const deadline = performance.now() + deadlineMs(20_000);
    while (!/leaked-server-pid \d+/u.test(output) && performance.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- polling one child's output until its server is up.
      await sleep(50);
    }
    // The test has passed and its hook is inside the slow kill-server.
    await sleep(800);
    const root = /sandbox-root (\S+)/u.exec(output)?.[1] ?? "";
    const exited = new Promise((resolve) => child.once("exit", resolve));

    child.kill("SIGINT");
    await exited;

    expect(root === "").toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(await isGone(leakedPid(output))).toBe(true);
  }, 60_000);

  test("names a kill-server that never returns instead of timing out the hook that ran it", async () => {
    const real = (await resolveControllerIdentity("tmux")).executablePath;
    const bin = join(directory, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "tmux"),
      `#!/bin/sh\ncase " $* " in *" kill-server "*) sleep 600 ;; *) exec "${real}" "$@" ;; esac\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ["test", join(directory, "leak.test.ts")], {
      cwd: packageRoot,
      env: { ...outside(), PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const status = await new Promise((resolve) => child.once("exit", resolve));
    const root = /sandbox-root (\S+)/u.exec(output)?.[1] ?? "";

    expect(status).not.toBe(0);
    expect(output).toContain(
      `kill-server on the sandbox's "custom.sock" socket did not return within 5000 ms`,
    );
    expect(output).not.toContain("hook timed out");
    // Nothing stopped the server, which is the point; stop it here.
    process.kill(leakedPid(output));
    await rm(root, { force: true, recursive: true });
  }, 60_000);
});
