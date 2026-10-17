import { describe, expect, test } from "bun:test";

import { Server } from "../../src/server.js";
import type { TmuxCommandResult, TmuxInvocationRequest } from "../../src/engine.js";
import { flattenInvocation } from "../../src/engine.js";
import { TmuxTransportError, VersionTooLowError } from "../../src/errors.js";
import { checkedEngine, answerVersionProbe } from "../support/version_probe.js";

function success(request: TmuxInvocationRequest): TmuxCommandResult {
  return {
    cmd: [request.executable, ...flattenInvocation(request)],
    exitCode: 0,
    signal: null,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
}

describe("server utility requests", () => {
  test("rejects invalid server deadlines before invoking the engine", () => {
    let executions = 0;
    const engine = checkedEngine((request) => {
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
    const engine = checkedEngine((request) => {
      requests.push(request);
      const isNameQuery = request.commands[0]?.includes("#{session_name}") === true;
      return Promise.resolve(
        isNameQuery
          ? { ...success(request), stdout: new TextEncoder().encode("work\n") }
          : success(request),
      );
    });
    const server = new Server({ engine, timeoutMs: 37 });

    expect(await server.hasSession("work")).toBe(true);
    expect(await server.isAlive()).toBe(true);

    expect(requests.map((request) => request.commands)).toEqual([
      [["list-sessions", "-F", "#{session_name}"]],
      [["list-sessions"]],
    ]);
    // The deadline covers the version check too, so what reaches the engine is what is left of it.
    for (const request of requests) {
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(37);
    }
  });

  test("does not answer yes for a name that is only a prefix of a real session", async () => {
    const engine = checkedEngine((request) =>
      Promise.resolve({ ...success(request), stdout: new TextEncoder().encode("alphabet\n") }),
    );
    const server = new Server({ engine, timeoutMs: 37 });

    expect(await server.hasSession("alpha")).toBe(false);
    expect(await server.hasSession("alphabet")).toBe(true);
  });

  test.each([
    "no server running on /tmp/ltx-absent/socket\n",
    "error connecting to /tmp/ltx-absent/socket (No such file or directory)\n",
  ])("hasSession reads a cold socket as no session: %s", async (reason) => {
    const engine = checkedEngine((request) =>
      Promise.resolve({
        ...success(request),
        exitCode: 1,
        stderr: new TextEncoder().encode(reason),
      }),
    );

    expect(await new Server({ engine }).hasSession("work")).toBe(false);
  });

  test.each([
    "error connecting to /tmp/ltx-private/socket (Permission denied)",
    "no current target",
  ])("hasSession raises a non-cold failure to list sessions: %s", async (reason) => {
    const engine = checkedEngine((request) =>
      Promise.resolve({
        ...success(request),
        exitCode: 1,
        stderr: new TextEncoder().encode(reason),
      }),
    );

    await expect(new Server({ engine }).hasSession("work")).rejects.toThrow(reason);
  });

  test("forwards setHook command controls to the engine", async () => {
    const requests: TmuxInvocationRequest[] = [];
    const engine = checkedEngine((request) => {
      requests.push(request);
      return Promise.resolve(success(request));
    });
    const controller = new AbortController();
    const server = new Server({ engine, timeoutMs: 91 });

    // The version check spends part of a deadline, so it happens before the one under test.
    await server.version();
    await server.setHook("after-new-window", "display-message hooked", {
      signal: controller.signal,
      timeoutMs: 37,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[0]?.timeoutMs).toBe(37);
  });

  test("rejects on a timeout rather than answering that nothing is there", async () => {
    const engine = checkedEngine(() =>
      Promise.reject(
        new TmuxTransportError("tmux did not answer", {
          delivery: "indeterminate",
          kind: "timeout",
          signal: "SIGTERM",
          stderr: new Uint8Array(),
          stdout: new Uint8Array(),
        }),
      ),
    );
    const server = new Server({ engine });

    await expect(server.isAlive()).rejects.toMatchObject({ kind: "timeout" });
    await expect(server.hasSession("work")).rejects.toMatchObject({ kind: "timeout" });
  });

  test("validates all layout syntax before metadata probes", async () => {
    let executions = 0;
    const engine = checkedEngine((request) => {
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
    const probes: TmuxInvocationRequest[] = [];
    const engine = checkedEngine((request) => Promise.resolve(success(request)), {
      probe: (request) => {
        probes.push(request);
        return answerVersionProbe(request, "3.4");
      },
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
    expect(probes).toHaveLength(1);
    expect(probes[0]?.signal).toBe(controller.signal);
    expect(probes[0]?.timeoutMs).toBe(37);
    await expect(
      server.validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }]),
    ).rejects.toThrow("invalid tmux layout for 3.4");
  });

  test.each([
    "no server running on /tmp/ltx-absent/socket\n",
    "error connecting to /tmp/ltx-absent/socket (No such file or directory)\n",
  ])("layout cold fallback retains the selected engine: %s", async (reason) => {
    const seen: string[] = [];
    const engine = checkedEngine(
      (request) => {
        seen.push(request.globalArgs.includes("-V") ? "-V" : request.commands[0]![0]);
        return Promise.resolve({
          ...success(request),
          stdout: new TextEncoder().encode("tmux 3.7c\n"),
        });
      },
      {
        probe: (request) => {
          seen.push("probe");
          return { ...success(request), exitCode: 1, stderr: new TextEncoder().encode(reason) };
        },
      },
    );
    await new Server({ engine }).validateLayouts([{ layout: "main-horizontal-m", panes: 1 }]);
    expect(seen).toEqual(["probe", "-V"]);
  });

  test.each([
    "error connecting to /tmp/ltx-private/socket (Permission denied)",
    "protocol version mismatch (client 8, server 7)",
    "server exited unexpectedly",
    "no current target",
  ])("layout probing preserves non-cold failures: %s", async (reason) => {
    const seen: string[] = [];
    const engine = checkedEngine((request) => Promise.resolve(success(request)), {
      probe: (request) => {
        seen.push("probe");
        return { ...success(request), exitCode: 1, stderr: new TextEncoder().encode(reason) };
      },
    });
    await expect(
      new Server({ engine }).validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }]),
    ).rejects.toThrow(reason);
    expect(seen).toEqual(["probe"]);
  });

  test("layout probing refuses a daemon below the floor", async () => {
    const engine = checkedEngine((request) => Promise.resolve(success(request)), {
      version: "3.3",
    });
    await expect(
      new Server({ engine }).validateLayouts([{ layout: "main-horizontal-mirrored", panes: 1 }]),
    ).rejects.toBeInstanceOf(VersionTooLowError);
  });

  test("does not hide an engine programming error as a dead server", async () => {
    const engine = checkedEngine(() => Promise.reject(new TypeError("broken engine")));

    await expect(new Server({ engine }).isAlive()).rejects.toThrow("broken engine");
  });

  test("does not report a live server as dead when the engine still returns returncode", async () => {
    const engine = checkedEngine((request) =>
      Promise.resolve({
        cmd: [request.executable, ...flattenInvocation(request)],
        returncode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
      } as never),
    );
    const server = new Server({ engine });

    await expect(server.isAlive()).rejects.toMatchObject({ kind: "contract" });
    await expect(server.hasSession("work")).rejects.toMatchObject({ kind: "contract" });
  });
});
