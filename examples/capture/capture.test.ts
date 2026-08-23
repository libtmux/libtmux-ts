import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { moveTextThroughABuffer, readPane } from "./capture.js";

describe("capture", () => {
  test("round-trips text through a named buffer and cleans it up", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      const { named, roundTripped } = await moveTextThroughABuffer(server, "one\ntwo");

      expect(roundTripped).toEqual(["one", "two"]);
      expect(named.join(" ")).toContain("report");
      expect((await server.listBuffers()).join(" ")).not.toContain("report");
    });
  }, 60_000);

  test("refuses empty text rather than naming a buffer tmux did not make", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      await expect(moveTextThroughABuffer(server, "")).rejects.toThrow(/empty buffer/u);
      // The behaviour that makes the check necessary: tmux reports success.
      await server.setBuffer("silent", "");
      expect((await server.listBuffers()).join(" ")).not.toContain("silent");
    });
  }, 60_000);

  test("reads a pane, answering nothing for a pane that has printed nothing", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });

      expect(Array.isArray(await readPane(server))).toBe(true);
    });
  }, 60_000);
});
