import { describe, expect, test } from "bun:test";

import { Server } from "../../src/server.js";
import type { TmuxCommandRequest, TmuxCommandResult } from "../../src/engine.js";
import { singleCommandTransport } from "../support/transport_double.js";

function success(request: TmuxCommandRequest): TmuxCommandResult {
  return {
    cmd: request.args,
    returncode: 0,
    signal: null,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
}

describe("server utility requests", () => {
  test("inherits the server deadline and targets a session name exactly", async () => {
    const requests: TmuxCommandRequest[] = [];
    const engine = singleCommandTransport((request) => {
      requests.push(request);
      return Promise.resolve(success(request));
    });
    const server = new Server({ engine, timeoutMs: 37 });

    expect(await server.hasSession("work")).toBe(true);
    expect(await server.isAlive()).toBe(true);

    expect(requests.map(({ args, timeoutMs }) => ({ args, timeoutMs }))).toEqual([
      { args: ["has-session", "-t", "=work"], timeoutMs: 37 },
      { args: ["list-sessions"], timeoutMs: 37 },
    ]);
  });

  test("does not hide an engine programming error as a dead server", async () => {
    const engine = singleCommandTransport(() => Promise.reject(new TypeError("broken engine")));

    await expect(new Server({ engine }).isAlive()).rejects.toThrow("broken engine");
  });
});
