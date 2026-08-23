import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { reportPanes } from "./fields.js";

describe("fields", () => {
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
});
