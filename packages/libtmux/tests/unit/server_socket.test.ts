import { describe, expect, test } from "bun:test";

import { socketFromEnvironment } from "../../src/_internal/runtime/connection.js";
import type { TmuxCommandResult, TmuxInvocationRequest } from "../../src/engine.js";
import { flattenInvocation } from "../../src/engine.js";
import { Server } from "../../src/server.js";
import { checkedEngine } from "../support/version_probe.js";

/**
 * The socket a `Server` addresses when it is given none: `LIBTMUX_SOCKET_PATH`,
 * else `LIBTMUX_SOCKET`, else no socket at all. Every case builds its own
 * `environment`, so nothing here reads or reaches the developer's tmux.
 */

function seen(): {
  readonly arguments: (readonly string[])[];
  readonly engine: ReturnType<typeof checkedEngine>;
} {
  const recorded: (readonly string[])[] = [];
  return {
    arguments: recorded,
    engine: checkedEngine((request: TmuxInvocationRequest) => {
      recorded.push(request.globalArgs);
      const result: TmuxCommandResult = {
        cmd: [request.executable, ...flattenInvocation(request)],
        exitCode: 0,
        signal: null,
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
      };
      return Promise.resolve(result);
    }),
  };
}

describe("the socket a Server is given none of", () => {
  test("is the path in LIBTMUX_SOCKET_PATH", () => {
    const server = new Server({ environment: { LIBTMUX_SOCKET_PATH: "/tmp/ltx-env.sock" } });

    expect(server.socketPath).toBe("/tmp/ltx-env.sock");
    expect(server.socketName).toBeUndefined();
  });

  test("is the name in LIBTMUX_SOCKET", () => {
    const server = new Server({ environment: { LIBTMUX_SOCKET: "ltx-env" } });

    expect(server.socketName).toBe("ltx-env");
    expect(server.socketPath).toBeUndefined();
  });

  test("is the path when both variables are set, as tmux ignores -L beside -S", () => {
    const server = new Server({
      environment: { LIBTMUX_SOCKET: "ltx-env", LIBTMUX_SOCKET_PATH: "/tmp/ltx-env.sock" },
    });

    expect(server.socketPath).toBe("/tmp/ltx-env.sock");
    expect(server.socketName).toBeUndefined();
  });

  test("is no socket when neither variable is set", () => {
    const server = new Server({ environment: {} });

    expect(server.socketName).toBeUndefined();
    expect(server.socketPath).toBeUndefined();
  });

  test("is no socket from TMUX, which tmux itself follows", () => {
    const server = new Server({ environment: { TMUX: "/tmp/ltx-tmux/sock,1234,0" } });

    expect(server.socketName).toBeUndefined();
    expect(server.socketPath).toBeUndefined();
  });

  test("counts an empty or whitespace-only variable as unset, each one alone", () => {
    for (const blank of ["", " ", "\t\n"]) {
      expect(new Server({ environment: { LIBTMUX_SOCKET: blank } }).socketName).toBeUndefined();
      expect(
        new Server({ environment: { LIBTMUX_SOCKET_PATH: blank } }).socketPath,
      ).toBeUndefined();
      const named = new Server({
        environment: { LIBTMUX_SOCKET: "ltx-env", LIBTMUX_SOCKET_PATH: blank },
      });
      expect(named.socketName).toBe("ltx-env");
      expect(named.socketPath).toBeUndefined();
      const pathed = new Server({
        environment: { LIBTMUX_SOCKET: blank, LIBTMUX_SOCKET_PATH: "/tmp/ltx-env.sock" },
      });
      expect(pathed.socketPath).toBe("/tmp/ltx-env.sock");
    }
  });

  test("uses any other value as written, spaces and all", () => {
    expect(new Server({ environment: { LIBTMUX_SOCKET: " my socket " } }).socketName).toBe(
      " my socket ",
    );
    expect(
      new Server({ environment: { LIBTMUX_SOCKET_PATH: "relative/ltx.sock" } }).socketPath,
    ).toBe("relative/ltx.sock");
  });

  test("reads the environment option, and the process only when that is absent", () => {
    const previous = process.env.LIBTMUX_SOCKET;
    process.env.LIBTMUX_SOCKET = "ltx-from-process";
    try {
      expect(new Server().socketName).toBe("ltx-from-process");
      expect(new Server({ environment: {} }).socketName).toBeUndefined();
      expect(new Server({ environment: { LIBTMUX_SOCKET: "ltx-given" } }).socketName).toBe(
        "ltx-given",
      );
    } finally {
      if (previous === undefined) delete process.env.LIBTMUX_SOCKET;
      else process.env.LIBTMUX_SOCKET = previous;
    }
  });
});

describe("a socket the caller gives", () => {
  const both = { LIBTMUX_SOCKET: "ltx-env", LIBTMUX_SOCKET_PATH: "/tmp/ltx-env.sock" };

  test("beats both variables when it is a name", () => {
    const server = new Server({ environment: both, socketName: "ltx-given" });

    expect(server.socketName).toBe("ltx-given");
    expect(server.socketPath).toBeUndefined();
  });

  test("beats both variables when it is a path", () => {
    const server = new Server({ environment: both, socketPath: "/tmp/ltx-given.sock" });

    expect(server.socketPath).toBe("/tmp/ltx-given.sock");
    expect(server.socketName).toBeUndefined();
  });

  test("still conflicts with the other kind of socket", () => {
    expect(
      () => new Server({ environment: both, socketName: "a", socketPath: "/tmp/b.sock" }),
    ).toThrow("socketName and socketPath are mutually exclusive");
  });
});

describe("socketFromEnvironment", () => {
  test("names nothing for an environment with no variable", () => {
    expect(socketFromEnvironment({ HOME: "/home/ltx", TMUX: "/tmp/x,1,0" })).toEqual({});
  });
});

describe("what reaches tmux", () => {
  test("is no -L and no -S when nothing chose a socket", async () => {
    const recorded = seen();
    const server = new Server({
      engine: recorded.engine,
      environment: { TMUX: "/tmp/ltx-tmux/sock,1234,0" },
    });

    await server.cmd("list-sessions");

    expect(recorded.arguments.length).toBeGreaterThan(0);
    for (const globalArgs of recorded.arguments) {
      expect(globalArgs.filter((argument) => /^-[LS]/u.test(argument))).toEqual([]);
    }
  });

  test("is -S with the path LIBTMUX_SOCKET_PATH names", async () => {
    const recorded = seen();
    const server = new Server({
      engine: recorded.engine,
      environment: { LIBTMUX_SOCKET: "ltx-env", LIBTMUX_SOCKET_PATH: "/tmp/ltx-env.sock" },
    });

    await server.cmd("list-sessions");

    expect(recorded.arguments.length).toBeGreaterThan(0);
    for (const globalArgs of recorded.arguments) {
      expect(globalArgs).toContain("-S/tmp/ltx-env.sock");
      expect(globalArgs.filter((argument) => argument.startsWith("-L"))).toEqual([]);
    }
  });

  test("is -L with the name LIBTMUX_SOCKET names", async () => {
    const recorded = seen();
    const server = new Server({ engine: recorded.engine, environment: { LIBTMUX_SOCKET: "ltx" } });

    await server.cmd("list-sessions");

    expect(recorded.arguments.length).toBeGreaterThan(0);
    for (const globalArgs of recorded.arguments) {
      expect(globalArgs).toContain("-Lltx");
      expect(globalArgs.filter((argument) => argument.startsWith("-S"))).toEqual([]);
    }
  });
});
