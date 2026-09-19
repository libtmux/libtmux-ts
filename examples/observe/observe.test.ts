import { describe, expect, test } from "bun:test";

import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { whatTheLibraryIsDoing } from "./observe.js";

describe("observe", () => {
  test("the observe example counts what the library sent, and what waited", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const session = (await server.snapshot()).sessions.one();
      await session.newWindow({ name: "observed" });
      await session.newWindow({ name: "observed-too" });

      const run = await whatTheLibraryIsDoing(server);

      // The two claims the README rests on, measured rather than asserted.
      expect(run.snapshotCalls).toBe(1);
      // The probe, then the snapshot — paid once per server, not per call.
      expect(run.firstCallCalls).toBe(2);
      expect(run.queryCalls).toBe(0);
      // One slot and four concurrent snapshots: three of them had to wait.
      expect(run.queued).toBe(3);

      // Every report carries what the invocation cost and how it ended.
      expect(run.reports.length).toBeGreaterThan(0);
      for (const report of run.reports) {
        expect(report.delivery).toBe("replied");
        expect(report.exitCode).toBe(0);
        expect(report.error).toBeUndefined();
      }
    });
  }, 60_000);
});
