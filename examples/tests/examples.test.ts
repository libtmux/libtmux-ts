// The library's real-tmux fixture harness, which is internal and unpublished.
// In-repo consumers use it directly; external ones have no need for it.
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { quickstart } from "../quickstart.js";
import { reportPanes } from "../fields.js";
import { buildWorkspace, removeWorkspace } from "../workspace.js";
import { buildAndSettle, runAndWait } from "../agent.js";
import {
  collectPaneOutput,
  readOutputUnderBackpressure,
  stopWaiting,
  watchUntilWindowOpens,
  watchWithBackpressure,
} from "../watch.js";
import {
  buildWorkspace as buildMcpWorkspace,
  connectAgent,
  runAndCheck,
  waitFor,
  watch as watchPane,
} from "../mcp-agent.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../packages/libtmux/src/_internal/test/run_root.js";
import { TestServer } from "../../packages/libtmux/src/_internal/test/test_server.js";
import { Server } from "../../packages/libtmux/src/server.js";

import {
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../packages/libtmux/src/_internal/test/temp_root.js";

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-examples-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "examples" });
        assertOwnedSocketPath(fixture.socketPath);
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

describe("documented examples", () => {
  test("the quickstart runs end to end against real tmux", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const snapshot = await quickstart(server);

      expect(snapshot.sessions.count({ name: "quickstart" })).toBe(1);
      expect(snapshot.windows.count({ name: "editor" })).toBe(1);
      expect(snapshot.panes.count({ window: { is: { name: "editor" } } })).toBe(2);
    });
  }, 60_000);

  test("the fields example reads decoded values against real tmux", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const report = await reportPanes(server);

      // Values tmux sent as text, used as the types they stand for.
      expect(report.activeCount).toBe(2);
      expect(report.area).toBeGreaterThan(0);
      expect(report.pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
      expect(report.pids.length).toBeGreaterThan(0);
      expect(report.sessionAgeMs).toBeGreaterThanOrEqual(0);
      expect(report.sessionAgeMs).toBeLessThan(60_000);
    });
  }, 60_000);

  test("the watch example observes a window opening", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const event = await watchUntilWindowOpens(server);

      expect(event.kind).toBe("window-add");
    });
  }, 60_000);

  test("the pane-output example follows a pane until its marker arrives", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const collected = collectPaneOutput(server, "example-marker");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await fixture.executeText([
        "new-window",
        "-d",
        "-t",
        "examples:",
        "printf 'example-marker\\n'; sleep 5",
      ]);

      expect(await collected).toContain("example-marker");
    });
  }, 60_000);

  test("the pause-after example reports a pause and its resume", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const flow = await watchWithBackpressure(server);

      // A pause and the resume this connection asked for, in that order.
      expect(flow.length).toBe(2);
      expect(flow[0]?.startsWith("pause %")).toBe(true);
      expect(flow[1]).toBe(flow[0]?.replace("pause", "continue"));
    });
  }, 60_000);

  test("the paced example still reads a pane's output", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      // tmux writes a paced pane's output under a different notification name,
      // and every recipe here matches on `kind === "output"`. Asserting the
      // pause and the resume, and never the output they pace, is what let that
      // difference go unnoticed.
      const read = await readOutputUnderBackpressure(server, "paced-marker");

      expect(read.text).toContain("paced-marker");
      expect(read.reportedAge).toBe(true);
    });
  }, 60_000);

  test("the cancellation example separates giving up from breaking", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      // Both are a caller deciding to stop, so both answer rather than raise.
      const outcome = await stopWaiting(server);

      expect(outcome.onDeadline).toBe("undefined");
      expect(outcome.onClose).toBe("undefined");
    });
  }, 60_000);

  test("the agent example acts and waits on one connection", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const seen = await runAndWait(server, "printf 'agent-done\\n'", "agent-done");

      expect(seen).toContain("agent-done");
    });
  }, 60_000);

  test("the settling example waits for the shape it built", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const count = await buildAndSettle(server, ["build", "test"]);

      expect(count).toBeGreaterThanOrEqual(3);
    });
  }, 60_000);

  test("the workspace example builds the layout it was given", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const session = await buildWorkspace(server, {
        environment: { LTX_WORKSPACE: "example" },
        name: "workspace-example",
        windows: [
          { command: "sleep 30", name: "editor", panes: [{ command: "sleep 30" }] },
          { command: "sleep 30", name: "server" },
          { command: "sleep 30", name: "logs" },
        ],
      });

      const built = (await server.snapshot()).sessions.one({ name: "workspace-example" });
      expect(built.windows.map((window) => window.name)).toEqual(["editor", "server", "logs"]);
      expect(built.windows.one({ name: "editor" }).panes.length).toBe(2);
      expect(await built.getEnvironment("LTX_WORKSPACE")).toBe("example");
      expect(session.id).toBe(built.id);

      expect(await removeWorkspace(server, "workspace-example")).toBe(true);
      // Removing one that is already gone is an answer, not a failure.
      expect(await removeWorkspace(server, "workspace-example")).toBe(false);
    });
  }, 60_000);

  test("the mcp example reports a command's own output and its status", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const client = await connectAgent(server);
      await runWithCleanup(
        async () => {
          const [paneId = ""] = await buildMcpWorkspace(client, "mcp-example", ["shell"]);

          // The echo trap: the text waited for is also in the command sent.
          const ran = await runAndCheck(client, paneId, "echo hello");
          expect(ran.outcome).toBe("completed");
          expect(ran.exitStatus).toBe(0);
          expect(ran.output).toBe("hello");

          const failed = await runAndCheck(client, paneId, "exit 3");
          expect(failed.exitStatus).toBe(3);

          // A wait that misses is still an answer, not an empty hand.
          const missed = await waitFor(client, paneId, "never-printed-here", 1_500);
          expect(missed.outcome).toBe("timed_out");
          expect(missed.screen).toContain("hello");

          // And a repeated read is charged only for what is new.
          const next = await watchPane(client, paneId);
          await runAndCheck(client, paneId, "echo delta");
          const delta = await next(5_000);
          expect(delta.text).toContain("delta");
        },
        () => client.close(),
      );
    });
  }, 90_000);
});
