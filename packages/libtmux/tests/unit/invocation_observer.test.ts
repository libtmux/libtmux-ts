import { describe, expect, test } from "bun:test";

import { Server } from "../../src/server.js";
import type { TmuxInvocationReport } from "../../src/common.js";
import type { TmuxCommandResult, TmuxInvocationRequest } from "../../src/engine.js";
import { flattenInvocation } from "../../src/engine.js";
import { singleCommandTransport } from "../support/transport_double.js";

function result(request: TmuxInvocationRequest, exitCode = 0): TmuxCommandResult {
  return {
    cmd: [request.executable, ...flattenInvocation(request)],
    exitCode,
    signal: null,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
}

const names = (reports: readonly TmuxInvocationReport[]): string[] =>
  reports.map((report) => report.commands[0]?.[0] ?? "");

describe("invocation observer", () => {
  /**
   * The seam a caller otherwise has to write a whole engine to reach. It
   * replaces `TmuxLogger` and `TmuxWarningSink`, which were exported, defaulted
   * to no-ops, reachable through no option, and called from nowhere.
   */
  test("reports every command, with what it cost and how it ended", async () => {
    const reports: TmuxInvocationReport[] = [];
    const server = new Server({
      engine: singleCommandTransport((request) => Promise.resolve(result(request))),
      onInvocation: (report) => reports.push(report),
    });

    await server.runShell("true");
    await server.setOption("status", "off");

    expect(names(reports)).toEqual(["run-shell", "set-option"]);
    for (const report of reports) {
      expect(report.exitCode).toBe(0);
      expect(report.delivery).toBe("replied");
      expect(report.error).toBeUndefined();
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.queuedMs).toBe(0);
    }
  });

  test("reports a command tmux refused, which is an answer rather than a fault", async () => {
    const reports: TmuxInvocationReport[] = [];
    const server = new Server({
      engine: singleCommandTransport((request) => Promise.resolve(result(request, 1))),
      onInvocation: (report) => reports.push(report),
    });

    expect(await server.isAlive()).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.exitCode).toBe(1);
    expect(reports[0]?.delivery).toBe("replied");
  });

  test("reports an invocation that never answered, carrying its delivery", async () => {
    const reports: TmuxInvocationReport[] = [];
    const controller = new AbortController();
    const server = new Server({
      engine: singleCommandTransport(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      ),
      onInvocation: (report) => reports.push(report),
    });

    const pending = server.runShell("sleep 10", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.exitCode).toBeUndefined();
    expect(reports[0]?.error).toBeDefined();
  });

  /**
   * A command must not fail on account of the code watching it, and an
   * observer that throws has no way to report that which is not worse.
   */
  test("does not let a throwing observer fail the command", async () => {
    const server = new Server({
      engine: singleCommandTransport((request) => Promise.resolve(result(request))),
      onInvocation: () => {
        throw new Error("observer is broken");
      },
    });

    expect(await server.runShell("true")).toEqual([]);
  });

  test("charges the wait for a slot to queuedMs rather than to the command", async () => {
    const reports: TmuxInvocationReport[] = [];
    const release: (() => void)[] = [];
    const server = new Server({
      engine: singleCommandTransport(
        (request) =>
          new Promise((resolve) => {
            release.push(() => resolve(result(request)));
          }),
      ),
      maxInFlight: 1,
      onInvocation: (report) => reports.push(report),
    });

    const first = server.runShell("one");
    const second = server.runShell("two");
    await Promise.resolve();
    // The second is queued behind the first, so only the first has started.
    expect(release).toHaveLength(1);

    release[0]?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 5));
    release[1]?.();
    await second;

    expect(reports).toHaveLength(2);
    expect(reports[0]?.queuedMs).toBe(0);
    expect(reports[1]?.queuedMs).toBeGreaterThan(0);
  });
});
