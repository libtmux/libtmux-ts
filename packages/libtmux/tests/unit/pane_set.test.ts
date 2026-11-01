import { describe, expect, test } from "bun:test";

import { PaneSet } from "../../src/pane_set.js";
import { TmuxCommandError, TmuxTransportError } from "../../src/errors.js";
import type { RawCommandResult } from "../../src/_internal/transport/types.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";
import { createRichProjectedHarness } from "../support/selection_fixtures.js";
import { invalidateRuntimeEpoch } from "../../src/_internal/runtime/context.js";

describe("ordered pane operations", () => {
  test("copies duplicate slots and retains immutable results and capture text", async () => {
    const { panes: harness } = await createRichProjectedHarness();
    const pane = harness.values[0]!;
    harness.transport.execute = (request) =>
      Promise.resolve({
        cmd: [request.executable, ...flattenInvocation(request)],
        exitCode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode("visible\n\n"),
      });
    const input = [pane, pane];
    const group = new PaneSet(input);
    input.pop();
    const results = await group.capture();
    expect(
      results.map(({ index, target, status, delivery, value }) => [
        index,
        target.id,
        status,
        delivery,
        value,
      ]),
    ).toEqual([
      [0, pane.id, "complete", "replied", ["visible"]],
      [1, pane.id, "complete", "replied", ["visible"]],
    ]);
    expect(group.panes).toHaveLength(2);
    expect(results[0]?.result?.stdout).toEqual(["visible", ""]);
    for (const value of [
      group.panes,
      results,
      results[0],
      results[0]?.value,
      results[0]?.target,
      results[0]?.result,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test("bounds active work, reaches later slots and preserves original causes", async () => {
    const { panes: harness } = await createRichProjectedHarness();
    const resolvers: ((value: RawCommandResult) => void)[] = [];
    const requests: string[] = [];
    const entered: (() => void)[] = [];
    harness.transport.execute = (request) => {
      requests.push(request.commands[0]?.join(" ") ?? "");
      entered.shift()?.();
      return new Promise((resolve) => resolvers.push(resolve));
    };
    const began = new Promise<void>((resolve) => entered.push(resolve));
    const group = new PaneSet([harness.values[0]!, harness.values[1]!, harness.values[0]!], {
      concurrency: 1,
    });
    const pending = group.capture();
    await began;
    expect(requests).toHaveLength(1);
    const next = new Promise<void>((resolve) => entered.push(resolve));
    resolvers.shift()?.({
      cmd: ["tmux"],
      exitCode: 1,
      signal: null,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode("no pane"),
    });
    await next;
    expect(requests).toHaveLength(2);
    const last = new Promise<void>((resolve) => entered.push(resolve));
    resolvers.shift()?.({
      cmd: ["tmux"],
      exitCode: 0,
      signal: null,
      stdout: new TextEncoder().encode("second"),
      stderr: new Uint8Array(),
    });
    await last;
    resolvers.shift()?.({
      cmd: ["tmux"],
      exitCode: 0,
      signal: null,
      stdout: new TextEncoder().encode("last"),
      stderr: new Uint8Array(),
    });
    const result = await pending;
    expect(result.map(({ status }) => status)).toEqual(["failed", "complete", "complete"]);
    expect(result[0]?.error).toBeInstanceOf(TmuxCommandError);
    expect(result[1]?.value).toEqual(["second"]);
    expect(result[2]?.value).toEqual(["last"]);
  });

  test("skips pre-cancelled slots and never retries uncertain submissions", async () => {
    const { panes: harness } = await createRichProjectedHarness();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const cause = new TmuxTransportError("accepted but unanswered", {
      delivery: "indeterminate",
      kind: "cancelled",
    });
    harness.transport.execute = () => {
      calls += 1;
      return Promise.reject(cause);
    };
    const group = new PaneSet([harness.values[0]!, harness.values[0]!]);
    const skipped = await group.sendKeys("go", { signal: controller.signal });
    expect(skipped.map(({ status, delivery }) => [status, delivery])).toEqual([
      ["skipped", "not_started"],
      ["skipped", "not_started"],
    ]);
    expect(calls).toBe(0);
    const unknown = await group.sendKeys("go");
    expect(unknown.map(({ status, delivery }) => [status, delivery])).toEqual([
      ["unknown", "indeterminate"],
      ["unknown", "indeterminate"],
    ]);
    expect(unknown[0]?.error).toBe(cause);
    expect(unknown[1]?.error).toBe(cause);
    expect(calls).toBe(2);
  });

  test("starts the requested worker count and skips queued slots after cancellation", async () => {
    const { panes: harness } = await createRichProjectedHarness();
    const controller = new AbortController();
    const cause = new TmuxTransportError("cancelled after submission", {
      delivery: "written",
      kind: "cancelled",
    });
    let calls = 0;
    let started: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    harness.transport.execute = (request) => {
      calls += 1;
      if (calls === 2) started?.();
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(cause), { once: true });
      });
    };
    const group = new PaneSet([harness.values[0]!, harness.values[1]!, harness.values[2]!], {
      concurrency: 2,
    });
    const pending = group.sendKeys("go", { signal: controller.signal });
    await active;
    expect(calls).toBe(2);
    controller.abort();
    const results = await pending;
    expect(results.map(({ status }) => status)).toEqual(["unknown", "unknown", "skipped"]);
    expect(results[0]?.error).toBe(cause);
    expect(calls).toBe(2);
  });

  test("refuses stale-daemon handles before dispatch", async () => {
    const { panes: harness } = await createRichProjectedHarness();
    let calls = 0;
    harness.transport.execute = () => {
      calls += 1;
      return Promise.reject(new Error("a stale handle reached transport"));
    };
    invalidateRuntimeEpoch(harness.runtime);
    const results = await new PaneSet(harness.values).sendKeys("go");
    expect(
      results.every(
        ({ status, reason, delivery }) =>
          status === "failed" && reason === "stale_daemon" && delivery === "not_started",
      ),
    ).toBe(true);
    expect(calls).toBe(0);
  });

  test("accepts an empty group and refuses invalid bounds before work", async () => {
    expect(await new PaneSet([]).capture()).toEqual([]);
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => new PaneSet([], { concurrency: value })).toThrow(TypeError);
      expect(() => new PaneSet([], { maxTargets: value })).toThrow(TypeError);
    }
    const { panes: harness } = await createRichProjectedHarness();
    expect(() => new PaneSet(harness.values, { maxTargets: 1 })).toThrow(RangeError);
  });
});
