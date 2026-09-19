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

  /**
   * The `void` return type is bivariant, so an `async` observer type-checks
   * against it — and reports its failure as a rejected promise rather than a
   * throw, which the `try`/`catch` guarding the callback cannot see. Left
   * alone it is an unhandled rejection, and on the default Node policy that
   * takes the host process down: the same broken promise as a throwing
   * observer failing the command, by a longer route.
   */
  test("does not let an async observer's rejection escape", async () => {
    const escaped: unknown[] = [];
    const watch = (reason: unknown): void => void escaped.push(reason);
    // Bun's `process` types admit only `memoryPressure`, so the listener pair
    // is reached through a narrow handle rather than a blanket cast.
    type RejectionEvents = Record<
      "off" | "on",
      (event: "unhandledRejection", listener: (reason: unknown) => void) => void
    >;
    const rejections = process as unknown as RejectionEvents;

    rejections.on("unhandledRejection", watch);
    try {
      const server = new Server({
        engine: singleCommandTransport((request) => Promise.resolve(result(request))),
        onInvocation: () => Promise.reject(new Error("observer is broken")),
      });

      expect(await server.runShell("true")).toEqual([]);
      // Rejections are reported once the microtask queue has drained, so give
      // the loop a turn rather than a timer.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      rejections.off("unhandledRejection", watch);
    }

    expect(escaped).toEqual([]);
  });

  /**
   * `TmuxInvocationReport` models `delivery: "not_started"` and a `queuedMs`
   * for exactly this case: a request refused while queued, before the
   * invocation reaches the engine.
   */
  test("reports a request refused while it waited for a slot", async () => {
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

    const holding = server.runShell("holds the slot");
    await Promise.resolve();
    const refused = server.runShell("never gets one", { timeoutMs: 10 });
    await expect(refused).rejects.toMatchObject({ delivery: "not_started" });

    const queued = reports.find((report) => report.delivery === "not_started");
    expect(queued, "the refused request reports").toBeDefined();
    expect(queued?.exitCode).toBeUndefined();
    expect(queued?.queuedMs).toBeGreaterThan(0);
    // `durationMs` is time on the invocation, and this never became one. The
    // whole elapsed time was the wait, which `queuedMs` already carries —
    // reporting it as both makes a consumer summing them count it twice.
    expect(queued?.durationMs).toBeLessThan(queued?.queuedMs ?? 0);

    release[0]?.();
    await holding;
  });

  test("calls a command that threw without saying how far it got indeterminate", async () => {
    const reports: TmuxInvocationReport[] = [];
    const server = new Server({
      engine: singleCommandTransport(() => Promise.reject(new Error("engine is broken"))),
      onInvocation: (report) => reports.push(report),
    });

    await expect(server.runShell("true")).rejects.toThrow();
    // `replied` means an answer, either way. This never answered.
    expect(reports[0]?.delivery).toBe("indeterminate");
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

  /**
   * The reporting paths above were added by splitting the dispatch in two, and
   * a permit released twice or not at all is the way that goes wrong: the
   * ceiling would drift, or the queue would stall with slots nobody holds.
   * Forty invocations mixing answers, engine failures and deadline refusals,
   * then one more that can only run if a permit survived all of it.
   */
  test("keeps the permit count honest across answers, failures and refusals", async () => {
    let live = 0;
    let peak = 0;
    const deliveries: string[] = [];
    const server = new Server({
      engine: singleCommandTransport(async (request) => {
        live += 1;
        peak = Math.max(peak, live);
        const refuses = request.commands[0][1] === "boom";
        await new Promise((resolve) => setTimeout(resolve, 2));
        live -= 1;
        if (refuses) throw new Error("engine refused");
        return result(request);
      }),
      maxInFlight: 2,
      onInvocation: (report) => deliveries.push(report.delivery),
    });

    const settled = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        server
          .runShell(index % 5 === 0 ? "boom" : "ok", index % 7 === 0 ? { timeoutMs: 1 } : {})
          .then(
            () => "answered",
            () => "refused",
          ),
      ),
    );

    expect(settled).toHaveLength(40);
    expect(peak, "the ceiling holds").toBe(2);
    // Only reachable if no permit leaked.
    expect(await server.runShell("after")).toEqual([]);
    expect([...new Set(deliveries)].sort()).toEqual(["indeterminate", "not_started", "replied"]);
  }, 20_000);
});
