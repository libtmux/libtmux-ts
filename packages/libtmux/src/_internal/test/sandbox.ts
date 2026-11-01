import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { accessSync, constants, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { makeTestDirectory } from "./temp_root.js";

/** Names the sandbox directory, so a child process can tell it is already inside one. */
export const SANDBOX_ENV = "LIBTMUX_TEST_SANDBOX";

/** The longest default socket path a sandbox accepts. */
export const SANDBOX_SOCKET_LIMIT = 100;

/** What picks a server before a socket option is read: `TMUX` beats `TMUX_TMPDIR`. */
const AMBIENT_VARIABLES: readonly string[] = [
  "TMUX",
  "TMUX_PANE",
  "LIBTMUX_SOCKET",
  "LIBTMUX_SOCKET_PATH",
];

type Environment = Record<string, string | undefined>;

/** The socket a tmux command with no `-L` or `-S` connects to, as tmux resolves it. */
export function tmuxSocketFor(
  environment: Readonly<Environment>,
  uid: number = process.getuid?.() ?? 0,
): string {
  const ambient = environment["TMUX"];
  if (ambient !== undefined && ambient !== "" && !ambient.startsWith(",")) {
    return ambient.split(",")[0] ?? ambient;
  }
  const base = environment["TMUX_TMPDIR"];
  return join(base === undefined || base === "" ? "/tmp" : base, `tmux-${String(uid)}`, "default");
}

/** Why `environment` could reach a tmux server it does not own; names, never values. */
export function sandboxFindings(
  environment: Readonly<Environment> = process.env,
): readonly string[] {
  const findings: string[] = [];
  for (const name of AMBIENT_VARIABLES) {
    if (environment[name] !== undefined) findings.push(`${name} is set`);
  }
  const root = environment[SANDBOX_ENV];
  if (root === undefined || !isAbsolute(root)) {
    findings.push(`${SANDBOX_ENV} does not name a sandbox directory`);
    return findings;
  }
  if (environment["TMUX_TMPDIR"] !== root) findings.push("TMUX_TMPDIR is not the sandbox");
  const socket = tmuxSocketFor(environment);
  if (!socket.startsWith(`${root}${sep}`)) {
    findings.push("a tmux command with no socket would use a socket outside the sandbox");
  }
  if (Buffer.byteLength(socket, "utf8") > SANDBOX_SOCKET_LIMIT) {
    findings.push(
      `the default socket path is over ${String(SANDBOX_SOCKET_LIMIT)} bytes; use a shorter TMPDIR`,
    );
  }
  try {
    const status = lstatSync(root);
    if (!status.isDirectory()) findings.push("the sandbox is not a directory");
    else if (process.getuid !== undefined && status.uid !== process.getuid()) {
      findings.push("the sandbox is owned by another user");
    } else if ((status.mode & 0o077) !== 0) findings.push("the sandbox is not owner-only");
  } catch {
    findings.push("the sandbox directory is missing");
  }
  return findings;
}

/** Refuse to go on unless `environment` is sandboxed; returns the sandbox root. */
export function assertSandboxed(environment: Readonly<Environment> = process.env): string {
  const findings = sandboxFindings(environment);
  if (findings.length > 0) {
    throw new Error(
      `refusing to run outside the tmux sandbox: ${findings.join("; ")}. ` +
        "Run from a package directory, whose bunfig.toml enters it, or through its test script.",
    );
  }
  return environment[SANDBOX_ENV] ?? "";
}

/** A sandbox this process entered, to leave when its tests are done. */
export interface Sandbox {
  /**
   * Stop what the run left and remove the sandbox, once; rejects naming each leftover socket and
   * keeps the directory while a server answers. A no-op for a sandbox another process made.
   */
  readonly release: () => Promise<void>;
  readonly root: string;
}

/** What `enterSandbox` can be told, for a caller that is not an ordinary test run. */
export interface SandboxOptions {
  /** The bound on each call to tmux or to a socket, after which the call is killed and named. */
  readonly deadlineMs?: number;
  /** The bound on the whole release; a release past it keeps the directory and rejects. */
  readonly releaseMs?: number;
  /** How long to keep checking that a stopped server has stopped answering. */
  readonly settleMs?: number;
  /** The binary that stops what is left; `tmux` on the PATH by default. */
  readonly tmux?: string;
  /** How a socket is connected to, `node:net`'s by default; a test stands in another runtime. */
  readonly connect?: (path: string) => Socket;
}

interface Bounds {
  readonly connect: (path: string) => Socket;
  readonly deadlineMs: number;
  readonly finishBy: number;
  readonly settleMs: number;
  readonly tmux: string;
}

/**
 * Whether a connect that failed with ENOENT means the socket is gone. Bun 1.3 says ENOENT for
 * every failure, so a file there that can be written is a refusal and one that cannot says nothing.
 */
function socketGone(path: string): boolean {
  try {
    lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a server may be listening; only a refusal or a socket that is gone says it is not. */
function listening(
  socketPath: string,
  boundMs: number,
  open: (path: string) => Socket,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = open(socketPath);
    const finish = (answers: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answers);
    };
    const timer = setTimeout(() => finish(true), boundMs);
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code !== "ECONNREFUSED" && (error.code !== "ENOENT" || !socketGone(socketPath))),
    );
  });
}

/** Whether a server still answers on the socket after `settleMs` of asking again. */
async function answersAfter(socketPath: string, bounds: Bounds): Promise<boolean> {
  const deadline = Date.now() + bounds.settleMs;
  // eslint-disable-next-line no-await-in-loop -- one probe at a time, paced.
  while (await listening(socketPath, Math.min(bounds.deadlineMs, 2_000), bounds.connect)) {
    if (Date.now() >= deadline) return true;
    // eslint-disable-next-line no-await-in-loop -- as above.
    await sleep(100);
  }
  return false;
}

/**
 * Run `kill-server` on a socket in a process group of its own. A call past `deadlineMs` has
 * the group killed and is waited for, so it neither hangs the release nor leaves a zombie.
 */
function stopServer(
  path: string,
  bounds: Bounds,
): Promise<"stopped" | "failed" | "unavailable" | "overran"> {
  return new Promise((resolve) => {
    let killed = false;
    let ended = false;
    let grace: NodeJS.Timeout | undefined;
    const end = (how: "stopped" | "failed" | "unavailable" | "overran"): void => {
      if (ended) return;
      ended = true;
      clearTimeout(bound);
      clearTimeout(grace);
      resolve(how);
    };
    const child = spawn(bounds.tmux, ["-S", path, "kill-server"], {
      detached: true,
      env: { ...process.env, TMUX: undefined },
      stdio: "ignore",
    });
    const bound = setTimeout(() => {
      killed = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // Collected once it exits; a call that will not even die is named all the same.
      grace = setTimeout(() => end("overran"), 1_000);
    }, bounds.deadlineMs);
    child.once("error", () => end("unavailable"));
    child.once("exit", (code) => end(killed ? "overran" : code === 0 ? "stopped" : "failed"));
  });
}

/** Every Unix socket under `root`, wherever a test put it; no link is followed. */
function socketsUnder(root: string): readonly string[] {
  const found: string[] = [];
  const pending = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSocket()) found.push(join(directory, entry.name));
      else if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
  return found;
}

/**
 * Whether a server listens on `socketPath`, per Linux's `/proc/net/unix`; where there is none,
 * it is taken to. Only the part under the sandbox is compared, and a path may hold spaces.
 */
function boundAndListening(root: string, socketPath: string): boolean {
  let table: string;
  try {
    table = readFileSync("/proc/net/unix", "utf8");
  } catch {
    return true;
  }
  const tail = `${basename(root)}/${relative(root, socketPath)}`;
  return table.split("\n").some((line) => {
    // Num RefCount Protocol Flags Type St Inode Path; flag 0x10000 is a listening socket.
    const fields = /^\s*\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/u.exec(line);
    return (
      fields !== null &&
      (fields[2] ?? "").endsWith(tail) &&
      (Number.parseInt(fields[1] ?? "0", 16) & 0x1_00_00) !== 0
    );
  });
}

/** Stop the server on each socket, then remove the sandbox unless one still answers. */
async function remove(
  root: string,
  bounds: Bounds,
): Promise<{ readonly kept: boolean; readonly left: readonly string[] }> {
  const left: string[] = [];
  let kept = false;
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return { kept, left };
  for (const path of socketsUnder(root)) {
    const name = relative(root, path);
    if (Date.now() >= bounds.finishBy) {
      left.push(`the release ran out of time before it reached the sandbox's "${name}" socket`);
      kept = true;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one socket at a time, each call bounded.
    const stopped = await stopServer(path, bounds);
    if (stopped === "overran") {
      left.push(
        `kill-server on the sandbox's "${name}" socket did not return within ${String(bounds.deadlineMs)} ms`,
      );
    }
    // eslint-disable-next-line no-await-in-loop -- as above.
    if (await answersAfter(path, bounds)) {
      left.push(`a server on the sandbox's "${name}" socket could not be stopped`);
      kept = true;
    } else if (stopped === "stopped") {
      left.push(
        `a server was left running on the sandbox's "${name}" socket and had to be stopped`,
      );
    }
  }
  if (!kept) rmSync(root, { force: true, recursive: true });
  return { kept, left };
}

/**
 * Put `environment` in a private tmux world, or confirm it already is in one. Children
 * inherit it and join; only the process that made it removes it.
 */
export async function enterSandbox(
  environment: Environment = process.env,
  options: SandboxOptions = {},
): Promise<Sandbox> {
  if (environment[SANDBOX_ENV] !== undefined) {
    return { release: () => Promise.resolve(), root: assertSandboxed(environment) };
  }
  const {
    connect: open = connect,
    deadlineMs = 5_000,
    releaseMs = 60_000,
    settleMs = 3_000,
    tmux = "tmux",
  } = options;
  const root = await makeTestDirectory("ltx-sandbox-").catch(() => {
    throw new Error("TMPDIR does not name a directory a sandbox can be made in");
  });
  for (const name of AMBIENT_VARIABLES) delete environment[name];
  environment["TMUX_TMPDIR"] = root;
  environment[SANDBOX_ENV] = root;
  let releasing: Promise<void> | undefined;
  const leave = async (): Promise<void> => {
    // Bun hides the inherited generic overload, so detach through the EventEmitter view.
    const processEvents: Pick<EventEmitter, "removeListener"> = process;
    processEvents.removeListener("exit", atExit);
    const { kept, left } = await remove(root, {
      connect: open,
      deadlineMs,
      finishBy: Date.now() + releaseMs,
      settleMs,
      tmux,
    });
    // A later round enters a sandbox of its own, and nothing sandboxed runs in between.
    delete environment[SANDBOX_ENV];
    if (left.length > 0) {
      const keeping = kept
        ? `; ${basename(root)} was kept, since a server may still answer in it`
        : "";
      throw new Error(
        `the tests left tmux running in their sandbox: ${left.join("; ")}${keeping}. A test that starts a server must kill it`,
      );
    }
  };
  // The first caller sees the outcome; a later one waits for it and sees none.
  const release = (): Promise<void> => {
    if (releasing !== undefined) return releasing.catch(() => undefined);
    releasing = leave();
    return releasing;
  };
  // The last chance for a process that never released: nothing can be awaited, so stop what is
  // there without waiting, keep the directory, and fail.
  const atExit = (): void => {
    releasing = Promise.resolve();
    const sockets = socketsUnder(root).filter((path) => boundAndListening(root, path));
    if (sockets.length === 0) {
      rmSync(root, { force: true, recursive: true });
      return;
    }
    for (const path of sockets) {
      spawn(tmux, ["-S", path, "kill-server"], {
        detached: true,
        env: { ...process.env, TMUX: undefined },
        stdio: "ignore",
      }).unref();
    }
    process.stderr.write(
      `the tests left tmux running in their sandbox and never released it; ${basename(root)} was kept. A test that starts a server must kill it\n`,
    );
    process.exitCode = 1;
  };
  process.on("exit", atExit);
  try {
    assertSandboxed(environment);
  } catch (error) {
    await release();
    throw error;
  }
  return { release, root };
}
