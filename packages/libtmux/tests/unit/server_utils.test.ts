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

  test("validates all layout syntax before metadata probes", async () => {
    let executions = 0;
    const engine = singleCommandTransport((request) => {
      executions++;
      return Promise.resolve(success(request));
    });
    const server = new Server({ engine });
    await server.validateLayouts([{ layout: "even-h", panes: 2 }]);
    await expect(
      server.validateLayouts([
        { layout: "main-horizontal-mirrored", panes: 1 },
        { layout: "32d2,80x24,0,0{}", panes: 1 },
      ]),
    ).rejects.toThrow("invalid tmux layout");
    expect(executions).toBe(0);
    const abort = new AbortController();
    abort.abort();
    await expect(
      server.validateLayouts([{ layout: "t", panes: 1 }], { signal: abort.signal }),
    ).rejects.toMatchObject({ kind: "cancelled", delivery: "not_started" });
    expect(executions).toBe(0);
  });

  test("layout version probes honor the daemon, engine and command controls", async () => {
    const requests: TmuxInvocationRequest[] = [];
    const engine = singleCommandTransport((request) => {
      requests.push(request);
      return Promise.resolve({ ...success(request), stdout: new TextEncoder().encode("3.4\n") });
    });
    const server = new Server({ engine, timeoutMs: 91 });
    const controller = new AbortController();
    await server.validateLayouts(
      [
        { layout: "main-h", panes: 1 },
        { layout: "main-v", panes: 2 },
      ],
      { signal: controller.signal, timeoutMs: 37 },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.commands).toEqual([["display-message", "-p", "#{version}"]]);
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[0]?.timeoutMs).toBe(37);
    await expect(
      server.validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }]),
    ).rejects.toThrow("invalid tmux layout for 3.4");
  });

  test.each([
    "no server running on /tmp/ltx-absent/socket\n",
    "error connecting to /tmp/ltx-absent/socket (No such file or directory)\n",
  ])("layout cold fallback retains the selected engine: %s", async (reason) => {
    const commands: string[] = [];
    const engine = singleCommandTransport((request) => {
      const command = request.commands[0]![0];
      commands.push(command);
      return Promise.resolve(
        command === "-V"
          ? { ...success(request), stdout: new TextEncoder().encode("tmux 3.7c\n") }
          : { ...success(request), returncode: 1, stderr: new TextEncoder().encode(reason) },
      );
    });
    await new Server({ engine }).validateLayouts([{ layout: "main-horizontal-m", panes: 1 }]);
    expect(commands).toEqual(["display-message", "-V"]);
  });

  test.each([
    "error connecting to /tmp/ltx-private/socket (Permission denied)",
    "protocol version mismatch (client 8, server 7)",
    "server exited unexpectedly",
    "no current target",
  ])("layout probing preserves non-cold failures: %s", async (reason) => {
    const commands: string[] = [];
    const engine = singleCommandTransport((request) => {
      commands.push(request.commands[0]![0]);
      return Promise.resolve({
        ...success(request),
        returncode: 1,
        stderr: new TextEncoder().encode(reason),
      });
    });
    await expect(
      new Server({ engine }).validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }]),
    ).rejects.toThrow(reason);
    expect(commands).toEqual(["display-message"]);
  });

  test.each(["", "unknown", "3.4\n3.7c"])(
    "layout probing preserves malformed version replies: %s",
    async (reply) => {
      const commands: string[] = [];
      const engine = singleCommandTransport((request) => {
        commands.push(request.commands[0]![0]);
        return Promise.resolve({ ...success(request), stdout: new TextEncoder().encode(reply) });
      });
      await expect(
        new Server({ engine }).validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }]),
      ).rejects.toThrow("invalid tmux version");
      expect(commands).toEqual(["display-message"]);
    },
  );

  test("does not hide an engine programming error as a dead server", async () => {
    const engine = singleCommandTransport(() => Promise.reject(new TypeError("broken engine")));

    await expect(new Server({ engine }).isAlive()).rejects.toThrow("broken engine");
  });
});
