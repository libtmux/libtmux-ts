import { describe, expect, test } from "bun:test";

import { Server } from "../../src/server.js";
import type { TmuxCommandResult, TmuxInvocationRequest } from "../../src/engine.js";
import { flattenInvocation } from "../../src/engine.js";
import { singleCommandTransport } from "../support/transport_double.js";

function success(request: TmuxInvocationRequest): TmuxCommandResult {
  return {
    cmd: [request.executable, ...flattenInvocation(request)],
    returncode: 0,
    signal: null,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
}

describe("server utility requests", () => {
  test("rejects invalid server deadlines before invoking the engine", () => {
    let executions = 0;
    const engine = singleCommandTransport((request) => {
      executions += 1;
      return Promise.resolve(success(request));
    });

    for (const timeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => new Server({ engine, timeoutMs })).toThrow(/timeoutMs/u);
    }
    expect(executions).toBe(0);
  });

  test("inherits the server deadline and targets a session name exactly", async () => {
    const requests: TmuxInvocationRequest[] = [];
    const engine = singleCommandTransport((request) => {
      requests.push(request);
      return Promise.resolve(success(request));
    });
    const server = new Server({ engine, timeoutMs: 37 });

    expect(await server.hasSession("work")).toBe(true);
    expect(await server.isAlive()).toBe(true);

    expect(
      requests.map((request) => ({ commands: request.commands, timeoutMs: request.timeoutMs })),
    ).toEqual([
      { commands: [["has-session", "-t", "=work"]], timeoutMs: 37 },
      { commands: [["list-sessions"]], timeoutMs: 37 },
    ]);
  });

  test("forwards setHook command controls to the engine", async () => {
    const requests: TmuxInvocationRequest[] = [];
    const engine = singleCommandTransport((request) => {
      requests.push(request);
      return Promise.resolve(success(request));
    });
    const controller = new AbortController();
    const server = new Server({ engine, timeoutMs: 91 });

    await server.setHook("after-new-window", "display-message hooked", {
      signal: controller.signal,
      timeoutMs: 37,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[0]?.timeoutMs).toBe(37);
  });

  test("does not hide an engine programming error as a dead server", async () => {
    const engine = singleCommandTransport(() => Promise.reject(new TypeError("broken engine")));

    await expect(new Server({ engine }).isAlive()).rejects.toThrow("broken engine");
  });
});
