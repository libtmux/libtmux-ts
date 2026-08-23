import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import {
  collectPaneOutput,
  readOutputUnderBackpressure,
  stopWaiting,
  watchUntilWindowOpens,
  watchWithBackpressure,
} from "./watch.js";

describe("watch", () => {
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
});
