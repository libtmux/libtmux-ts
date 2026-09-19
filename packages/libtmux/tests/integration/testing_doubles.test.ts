import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import type { TmuxEngine } from "../../src/engine.js";
import { flattenInvocation } from "../../src/engine.js";
import { TmuxServerRestartedError, TmuxTransportError } from "../../src/errors.js";
import { Server } from "../../src/server.js";
import { recordInvocations, replayInvocations, type TmuxRecording } from "../../src/testing.js";

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-doubles-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "doubles" });
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

describe("published test doubles", () => {
  /**
   * The property a consumer buys them for: record once against real tmux,
   * then run the same code with no server, no binary and no daemon, and get
   * the same answers. The replay half is what their unit tests use, so it has
   * to reproduce the guarded format protocol exactly — which is the part
   * nobody should have to write by hand.
   */
  test("replays a real server's answers with no tmux running", async () => {
    let recording: TmuxRecording | undefined;
    let liveNames: readonly string[] = [];
    let livePanes = 0;

    await withServer(async (fixture) => {
      const recorder = recordInvocations();
      const server = new Server({
        engine: recorder.engine,
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const session = (await server.snapshot()).sessions.one();
      await session.newWindow({ name: "recorded" });

      const snapshot = await server.snapshot();
      liveNames = snapshot.windows.toArray().map((window) => window.name ?? "");
      livePanes = snapshot.panes.length;
      recording = recorder.recording();
    });

    if (recording === undefined) throw new Error("expected a recording");
    expect(recording.invocations.length).toBeGreaterThan(0);
    // JSON, so it can live in a fixture file a reviewer reads.
    const restored = JSON.parse(JSON.stringify(recording)) as TmuxRecording;

    // No fixture, no socket, no binary. A recording is a run rather than a
    // database, so the same calls in the same order answer from the file.
    const replayed = new Server({ engine: replayInvocations(restored) });
    const session = (await replayed.snapshot()).sessions.one();
    await session.newWindow({ name: "recorded" });

    const snapshot = await replayed.snapshot();
    expect(snapshot.windows.toArray().map((window) => window.name ?? "")).toEqual([...liveNames]);
    expect(snapshot.panes.length).toBe(livePanes);
  }, 60_000);

  // `load-buffer -` is the same command whatever it is fed, so a recording
  // keyed on the commands alone would answer a test that wrote different bytes
  // with the ones it first saw — and a regression that corrupted a buffer
  // would replay as a pass.
  test("tells two invocations apart by what was written to their stdin", async () => {
    let recording: TmuxRecording | undefined;

    await withServer(async (fixture) => {
      const recorder = recordInvocations();
      const server = new Server({
        engine: recorder.engine,
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      await server.loadBuffer("probe", "AAA");
      expect(await server.showBuffer("probe")).toEqual(["AAA"]);
      await server.loadBuffer("probe", "ZZZ");
      expect(await server.showBuffer("probe")).toEqual(["ZZZ"]);
      recording = recorder.recording();
    });

    if (recording === undefined) throw new Error("expected a recording");
    const replayed = new Server({ engine: replayInvocations(recording) });
    await replayed.loadBuffer("probe", "AAA");
    expect(await replayed.showBuffer("probe")).toEqual(["AAA"]);
    await replayed.loadBuffer("probe", "ZZZ");
    expect(await replayed.showBuffer("probe")).toEqual(["ZZZ"]);

    // Bytes the recording never saw are refused rather than answered with
    // whatever the first write happened to hold.
    const other = new Server({ engine: replayInvocations(recording) });
    await expect(other.loadBuffer("probe", "QQQ")).rejects.toThrow(/no recorded answer/u);
  }, 60_000);

  // A replayed command answers from a file, which makes it easy to forget it
  // is still a command. A caller testing their own cancellation against a
  // recording that never checked would pass without exercising anything.
  test("refuses an already-cancelled command as the spawning engine does", async () => {
    const replayed = new Server({
      engine: replayInvocations({
        invocations: [{ commands: [["run-shell", "true"]], exitCode: 0, stderr: [], stdout: [] }],
        version: 1,
      }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(replayed.runShell("true", { signal: controller.signal })).rejects.toMatchObject({
      code: "TmuxTransportError",
      delivery: "not_started",
      kind: "cancelled",
    });
    // The recording is untouched, so the same call without a signal still answers.
    expect(await replayed.runShell("true")).toEqual([]);
  });

  // The queue is positional, so a failure the recorder drops does not merely
  // lose itself: the next call gets the answer belonging to the one after it.
  // A recorded failure would replay as a pass, and every later call is off by
  // one — a double that turns a red run green.
  test("writes a failure down, so a replay fails where the run failed", async () => {
    const answers = ["first\n", "third\n"];
    let calls = 0;
    const inner: TmuxEngine = {
      execute(request) {
        calls += 1;
        if (calls === 2) {
          throw new TmuxTransportError("command timed out", {
            delivery: "indeterminate",
            kind: "timeout",
          });
        }
        return Promise.resolve({
          cmd: [request.executable, ...flattenInvocation(request)],
          exitCode: 0,
          signal: null,
          stderr: new Uint8Array(),
          stdout: new TextEncoder().encode(answers.shift() ?? ""),
        });
      },
    };

    const recorder = recordInvocations(inner);
    const live = new Server({ engine: recorder.engine });
    expect(await live.runShell("x")).toEqual(["first"]);
    await expect(live.runShell("x")).rejects.toMatchObject({ kind: "timeout" });
    expect(await live.runShell("x")).toEqual(["third"]);

    const replayed = new Server({ engine: replayInvocations(recorder.recording()) });
    expect(await replayed.runShell("x")).toEqual(["first"]);
    // Rebuilt as the error the caller would have caught, not a bare Error:
    // a consumer branches on `code` and `delivery`, and a failure they cannot
    // branch on is no cheaper to test against than no failure at all.
    await expect(replayed.runShell("x")).rejects.toMatchObject({
      code: "TmuxTransportError",
      delivery: "indeterminate",
      kind: "timeout",
    });
    // The one that proves alignment: drop the failure and this call is the
    // one answered above, leaving nothing here.
    expect(await replayed.runShell("x")).toEqual(["third"]);
  });

  // The other error the built-in engine raises. Flattened to its message it
  // replays as a bare `Error`, so a consumer testing their restart handling
  // gets a false negative on exactly the branch they meant to exercise.
  test("replays a daemon restart as the error a consumer branches on", async () => {
    const inner: TmuxEngine = {
      execute() {
        throw new TmuxServerRestartedError("tmux refused the command", {
          subcommand: "list-panes",
        });
      },
    };
    const recorder = recordInvocations(inner);
    const live = new Server({ engine: recorder.engine });
    await expect(live.runShell("x")).rejects.toMatchObject({
      code: "TmuxServerRestartedError",
    });

    const replayed = new Server({ engine: replayInvocations(recorder.recording()) });
    const failure = await replayed.runShell("x").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TmuxServerRestartedError);
    expect(failure).toMatchObject({
      code: "TmuxServerRestartedError",
      delivery: "not_started",
      subcommand: "list-panes",
    });
  });

  test("refuses an invocation the recording never saw, rather than inventing one", async () => {
    const replayed = new Server({
      engine: replayInvocations({ invocations: [], version: 1 }),
    });
    await expect(replayed.snapshot()).rejects.toThrow(/no recorded answer/u);
  });

  test("answers repeated commands in the order they were recorded", async () => {
    let recording: TmuxRecording | undefined;

    await withServer(async (fixture) => {
      const recorder = recordInvocations();
      const server = new Server({
        engine: recorder.engine,
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      expect((await server.snapshot()).windows.length).toBe(1);
      await (await server.snapshot()).sessions.one().newWindow({ name: "second" });
      expect((await server.snapshot()).windows.length).toBe(2);
      recording = recorder.recording();
    });

    if (recording === undefined) throw new Error("expected a recording");
    // The same argv answered differently as the server changed, so a replay
    // keyed on argv alone would hand back the first answer twice.
    const replayed = new Server({ engine: replayInvocations(recording) });
    expect((await replayed.snapshot()).windows.length).toBe(1);
    await (await replayed.snapshot()).sessions.one().newWindow({ name: "second" });
    expect((await replayed.snapshot()).windows.length).toBe(2);
  }, 60_000);
});
