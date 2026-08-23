import { rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { TestServer } from "../../src/_internal/test/test_server.js";
import type { Server as ServerHandle } from "../../src/server.js";
import { Server } from "../../src/server.js";

/**
 * The world a README fragment is written against.
 *
 * The prose assumes a reader already holds a `server` and a `session`, and the
 * examples name them literally — a session called `work`, a window called
 * `editor`, a buffer called `scratch`, a home directory with a `.tmux.conf` in
 * it. Building exactly that is what lets a fragment run unaltered; the
 * alternative is rewriting every example to construct its own scenery, which
 * would bury what each one is showing.
 *
 * What the fixture could not supply is the interesting part. Every gap here was
 * found by running the examples rather than by reading them: a second client to
 * detach, because detaching the connection the world runs on takes the world
 * with it; a session named `other` to move a window into; a real `HOME`,
 * because `~` is expanded by the tmux server against the environment it was
 * launched with, so it has to be set before the server starts rather than
 * after.
 *
 * One server per block, torn down after it, so a block that kills a session —
 * or the server — costs the next one nothing.
 */

/** A `.tmux.conf` that changes something observable and breaks nothing. */
const TMUX_CONF = "set -g status off\n";

/**
 * The build the wait-for-marker recipe waits on.
 *
 * That example sends `make build` and reads until `BUILD OK` appears, which is
 * the whole point of it — so the fixture supplies a `make` that prints the
 * marker, the way the reader's own project would. Without it the recipe is
 * documented and never executed, which is exactly the shape of example that
 * goes wrong quietly.
 */
const MAKE_STUB = '#!/bin/sh\necho "BUILD OK"\n';

/**
 * The long-running commands the shell-command examples name.
 *
 * `newWindow({ shellCommand: "npm run dev" })` replaces the pane's shell, so a
 * command the fixture does not have exits at once and takes the pane with it —
 * which the prose says will happen, and which makes the example look broken
 * here for a reason that has nothing to do with the example.
 */
const STAYS_UP = "#!/bin/sh\nexec sleep 600\n";

export interface World {
  readonly bindings: Record<string, unknown>;
  readonly dispose: () => Promise<void>;
}

export interface WorldRequest {
  /** The block's body, which decides what scenery it needs. */
  readonly code: string;
  readonly index: number;
  /** One run root for the whole gate, so one reap can account for every server. */
  readonly runRoot: string;
  /** Where this block's home directory goes. */
  readonly scratch: string;
}

/**
 * The name the fixture's own session takes.
 *
 * `work` normally, because that is what the prose calls it and what the query
 * examples look up by name. A block that creates `work` itself needs the name
 * free, and creating a session is not the same as needing the scenery gone —
 * one block opens a `ci` session while still using the ambient `session`. So
 * only the name moves; everything else is built either way.
 */
function baseSessionName(code: string): string {
  const creates = [...code.matchAll(/newSession\([^)]*?name:\s*"(?<name>[^"]+)"/gsu)].map(
    (match) => match.groups?.["name"],
  );
  return creates.includes("work") ? "fixture" : "work";
}

/** A block that types into a pane needs one whose shell is listening. */
function sendsKeys(code: string): boolean {
  return /\bsendKeys\s*\(/u.test(code);
}

/**
 * Wait until the pane's shell actually receives what is sent to it.
 *
 * A shell that has drawn its prompt is not yet a shell that will keep the first
 * character sent to it: zsh's line editor eats it while starting, so
 * `sendKeys("make build")` arrives as `ake build` and the pane answers
 * `command not found: ake`. Nothing throws — the recipe simply waits forever
 * for output that a mistyped command was never going to produce.
 *
 * So the marker is sent until it comes back. `RE""ADY` is written that way on
 * purpose: the pane echoes what was typed, and the echo has to be
 * distinguishable from the output.
 */
async function settleShell(pane: {
  capture: () => Promise<readonly string[]>;
  sendKeys: (keys: string) => Promise<void>;
}): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- each attempt observes whether the last one landed.
    await pane.sendKeys(`echo RE""ADY`);
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- polling is the point: read, then wait, then read again.
      const lines = await pane.capture();
      if (lines.some((line) => line.includes("READY"))) return;
      // eslint-disable-next-line no-await-in-loop -- the pause between reads is what makes it a poll.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** `Session.fromEnv()` reads `$TMUX_PANE`, so the process has to look attached. */
function readsTmuxEnvironment(code: string): boolean {
  return /\bfromEnv\s*\(/u.test(code);
}

export async function buildWorld(request: WorldRequest): Promise<World> {
  const { runRoot } = request;

  // `~` is expanded by the tmux server against its own environment, so a home
  // directory handed over after launch is a home directory tmux never sees.
  const home = join(request.scratch, `home-${String(request.index)}`);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".tmux.conf"), TMUX_CONF);
  await writeFile(join(home, "payload.bin"), new Uint8Array([0, 1, 2, 3]));
  const binary = join(home, "bin");
  await mkdir(binary, { recursive: true });
  await writeFile(join(binary, "make"), MAKE_STUB, { mode: 0o755 });
  for (const name of ["npm", "just"]) {
    // eslint-disable-next-line no-await-in-loop -- two files, written in order.
    await writeFile(join(binary, name), STAYS_UP, { mode: 0o755 });
  }
  // `tail -f log/development.log` reads a path relative to the pane's cwd.
  await mkdir(join(home, "log"), { recursive: true });
  await writeFile(join(home, "log", "development.log"), "");

  const sessionName = baseSessionName(request.code);
  const fixture = await TestServer.create({
    environment: {
      ...process.env,
      HOME: home,
      PATH: `${binary}:${process.env["PATH"] ?? ""}`,
    },
    runRoot,
    sessionName,
  });
  const server = new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });

  const previousDirectory = process.cwd();
  const previousTmux = process.env["TMUX"];
  const previousPane = process.env["TMUX_PANE"];
  // `Bun.file("payload.bin")` is written as a reader would write it: relative
  // to wherever they are standing.
  process.chdir(home);

  const restore = (): void => {
    process.chdir(previousDirectory);
    if (previousTmux === undefined) delete process.env["TMUX"];
    else process.env["TMUX"] = previousTmux;
    if (previousPane === undefined) delete process.env["TMUX_PANE"];
    else process.env["TMUX_PANE"] = previousPane;
  };

  const closers: (() => Promise<void>)[] = [];
  const dispose = async (): Promise<void> => {
    restore();
    for (const close of closers.reverse()) {
      // eslint-disable-next-line no-await-in-loop -- connections close in the reverse of the order they opened.
      await close().catch(() => undefined);
    }
    // A block is free to kill its own server, so a failing teardown here is
    // not news. The gate's real check is the single reap at the end, which
    // sees every fixture this run created.
    await fixture.dispose().catch(() => undefined);
    await rm(home, { force: true, recursive: true });
  };

  try {
    return await furnish({ closers, dispose, fixture, request, server, sessionName });
  } catch (error) {
    await dispose();
    throw error;
  }
}

interface FurnishRequest {
  readonly closers: (() => Promise<void>)[];
  readonly dispose: () => Promise<void>;
  readonly fixture: TestServer;
  readonly request: WorldRequest;
  readonly server: ServerHandle;
  readonly sessionName: string;
}

async function furnish(input: FurnishRequest): Promise<World> {
  const { closers, dispose, request, server, sessionName } = input;

  const work = (await server.snapshot()).sessions.one({ name: sessionName });
  await work.newWindow({ name: "editor" });
  await work.newWindow({ name: "logs" });
  // `window.move({ session: "other" })` and `pane.joinTo("other:1")` both name a
  // second session, and the second needs a window at index 1 to join to.
  const elsewhere = await server.newSession({ name: "other", windowName: "first" });
  await elsewhere.newWindow({ name: "second" });
  await server.setBuffer("scratch", "scratch buffer contents");
  await server.setBuffer("captured", "captured buffer contents");

  // Connecting is what makes a client exist: tmux counts a control client like
  // any other, and the examples that read `client` have none otherwise.
  const live = await server.connect({ target: work.id });
  closers.push(() => live.close());

  // A second one, because `client.detach()` is a documented call and detaching
  // the connection the rest of the world runs on ends the block mid-sentence.
  const before = new Set((await server.snapshot()).clients.toArray().map((each) => each.name));
  const spare = await server.connect({ target: work.id });
  closers.push(() => spare.close());

  // Read through the ordinary server rather than the connection: the prose
  // introduces `server` and `pane` as plain handles, and `session.detach()`
  // detaches every client — the connection included — so handles born from it
  // would die halfway through the example that shows exactly that.
  const snapshot = await server.snapshot();
  const session = snapshot.sessions.one({ name: sessionName });
  const editor = snapshot.windows.one({ name: "editor", session: { is: { id: session.id } } });
  const logs = snapshot.windows.one({ name: "logs", session: { is: { id: session.id } } });
  const detachable = snapshot.clients.toArray().find((each) => !before.has(each.name));
  const pane = editor.panes.one();
  if (sendsKeys(request.code)) await settleShell(pane);

  if (readsTmuxEnvironment(request.code)) {
    // The example is written from inside tmux. Set only for the block that says
    // so: a set `$TMUX` makes tmux refuse `new-session` as nested.
    process.env["TMUX"] = `${input.fixture.socketPath},0,0`;
    process.env["TMUX_PANE"] = editor.panes.one().id;
  }

  return {
    bindings: {
      client: detachable ?? snapshot.clients.first(),
      command: "echo readme-example",
      editor,
      live,
      marker: "readme-example",
      other: logs,
      otherPane: logs.panes.one(),
      pane,
      selection: snapshot.sessions,
      server,
      session,
      snapshot,
      window: editor,
    },
    dispose,
  };
}

export async function disposeWorld(world: World): Promise<void> {
  await world.dispose();
}
