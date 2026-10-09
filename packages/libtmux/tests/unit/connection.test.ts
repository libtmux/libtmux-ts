import { describe, expect, test } from "bun:test";

import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { builtModuleUrl, runModule } from "../support/runtime_build.js";

describe("TmuxConnection", () => {
  test("rejects conflicting socket selectors", () => {
    expect(
      () =>
        new TmuxConnection({
          executable: "/usr/bin/tmux",
          socketName: "named",
          socketPath: "/tmp/tmux.sock",
        }),
    ).toThrow("socketName and socketPath are mutually exclusive");
  });

  test("copies and freezes connection configuration and environment", () => {
    const environment = { LC_ALL: "C.UTF-8", TERM: "tmux-256color" };
    const options = {
      colors: 256 as const,
      configFile: "/tmp/tmux.conf",
      environment,
      executable: "/usr/bin/tmux",
      socketName: "named",
    };

    const connection = new TmuxConnection(options);
    environment.TERM = "changed";
    options.configFile = "/tmp/changed.conf";

    expect(connection).toEqual({
      colors: 256,
      configFile: "/tmp/tmux.conf",
      environment: { LC_ALL: "C.UTF-8", TERM: "tmux-256color" },
      executable: "/usr/bin/tmux",
      socketName: "named",
      socketPath: `/tmp/tmux-${String(process.getuid!())}/named`,
      socketDirectory: { path: `/tmp/tmux-${String(process.getuid!())}`, uid: process.getuid!() },
    });
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(connection.environment)).toBe(true);
  });
});

describe("captured endpoint defaults", () => {
  const connect = (environment: Readonly<Record<string, string | undefined>> = {}) =>
    new TmuxConnection({ executable: "tmux", environment });

  test("captures the normal default path without starting tmux", () => {
    expect(connect().socketPath).toBe(`/tmp/tmux-${String(process.getuid!())}/default`);
    expect(connect().socketName).toBe("default");
  });

  test("prefers explicit selectors and ignores invalid lower-priority values", () => {
    const environment = {
      LIBTMUX_SOCKET_PATH: "relative",
      LIBTMUX_SOCKET_NAME: "../invalid",
      TMUX: "broken",
      TMUX_PANE: "invalid",
      TMUX_TMPDIR: "relative",
    };
    expect(
      new TmuxConnection({ executable: "tmux", environment, socketPath: "/tmp/explicit" })
        .socketPath,
    ).toBe("/tmp/explicit");
    expect(
      new TmuxConnection({
        executable: "tmux",
        environment: { ...environment, TMUX_TMPDIR: "/tmp/root" },
        socketName: "explicit",
      }).socketPath,
    ).toBe(`/tmp/root/tmux-${String(process.getuid!())}/explicit`);
  });

  test("selects path, then name, then TMUX, then default", () => {
    const context = "/tmp/context,123,0";
    expect(
      connect({
        LIBTMUX_SOCKET_PATH: "/tmp/path",
        LIBTMUX_SOCKET_NAME: "../ignored",
        TMUX: "broken",
        TMUX_TMPDIR: "relative",
      }).socketPath,
    ).toBe("/tmp/path");
    expect(
      connect({
        LIBTMUX_SOCKET_PATH: "",
        LIBTMUX_SOCKET_NAME: "named",
        TMUX: "broken",
        TMUX_TMPDIR: "/tmp/root",
      }).socketPath,
    ).toBe(`/tmp/root/tmux-${String(process.getuid!())}/named`);
    expect(
      connect({
        LIBTMUX_SOCKET_PATH: "",
        LIBTMUX_SOCKET_NAME: "",
        TMUX: context,
        TMUX_TMPDIR: "relative",
      }).socketPath,
    ).toBe("/tmp/context");
    expect(
      connect({ LIBTMUX_SOCKET_PATH: "", LIBTMUX_SOCKET_NAME: "", TMUX: "", TMUX_TMPDIR: "" })
        .socketPath,
    ).toBe(`/tmp/tmux-${String(process.getuid!())}/default`);
  });

  test("preserves spaces and commas in paths and names", () => {
    expect(connect({ TMUX: "/tmp/run, root/socket,321,0" }).socketPath).toBe(
      "/tmp/run, root/socket",
    );
    expect(connect({ TMUX: "/tmp/run, root/socket,321,$2" }).socketPath).toBe(
      "/tmp/run, root/socket",
    );
    expect(connect({ TMUX: "/tmp/run\nroot/socket,001,-1" }).socketPath).toBe(
      "/tmp/run\nroot/socket",
    );
    expect(connect({ LIBTMUX_SOCKET_PATH: "/tmp/with trailing space " }).socketPath).toBe(
      "/tmp/with trailing space ",
    );
    expect(connect({ LIBTMUX_SOCKET_NAME: " spaced ", TMUX_TMPDIR: "/tmp/root " }).socketPath).toBe(
      `/tmp/root /tmux-${String(process.getuid!())}/ spaced `,
    );
  });

  test("rejects invalid selected paths without falling back", () => {
    for (const path of ["relative", "with\0nul"]) {
      expect(() => connect({ LIBTMUX_SOCKET_PATH: path, LIBTMUX_SOCKET_NAME: "fallback" })).toThrow(
        TypeError,
      );
      expect(() => new TmuxConnection({ executable: "tmux", socketPath: path })).toThrow(TypeError);
    }
    expect(() => new TmuxConnection({ executable: "tmux", socketPath: "" })).toThrow(TypeError);
  });

  test("rejects invalid selected names and named roots", () => {
    for (const socketName of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(() => new TmuxConnection({ executable: "tmux", socketName })).toThrow(TypeError);
      if (socketName !== "")
        expect(() =>
          connect({ LIBTMUX_SOCKET_NAME: socketName, TMUX: "/tmp/fallback,1,0" }),
        ).toThrow(TypeError);
    }
    expect(() => connect({ LIBTMUX_SOCKET_NAME: "valid", TMUX_TMPDIR: "relative" })).toThrow(
      TypeError,
    );
    expect(() => connect({ TMUX_TMPDIR: "/tmp/with\0nul" })).toThrow(TypeError);
  });

  test("rejects malformed selected TMUX fields", () => {
    for (const TMUX of [
      "broken",
      "/tmp/s,1",
      "/tmp/s,,0",
      "/tmp/s,0,0",
      "/tmp/s,000,0",
      "/tmp/s,no,0",
      "/tmp/s,1,no",
      "/tmp/s,1,-2",
      "/tmp/s,1,$-1",
      "/tmp/s,1,+1",
      "relative,1,0",
      "/tmp/s\0,1,0",
    ]) {
      expect(() => connect({ TMUX })).toThrow(TypeError);
    }
  });

  test("captures inputs and removes attachment context only from the child copy", () => {
    const environment = {
      LIBTMUX_SOCKET_NAME: "before",
      TMUX_TMPDIR: "/tmp/before",
      TMUX: "/tmp/old,1,0",
      TMUX_PANE: "%4",
      PATH: "/bin",
    };
    const before = { ...environment };
    const connection = connect(environment);
    expect(environment).toEqual(before);
    environment.LIBTMUX_SOCKET_NAME = "after";
    environment.TMUX_TMPDIR = "/tmp/after";
    expect(connection.socketPath).toBe(`/tmp/before/tmux-${String(process.getuid!())}/before`);
    expect(connection.environment).not.toHaveProperty("TMUX");
    expect(connection.environment).not.toHaveProperty("TMUX_PANE");
    expect(connection.environment.PATH).toBe("/bin");
    expect(Object.isFrozen(connection.environment)).toBe(true);
  });

  test("the public default constructor captures host values before later edits and launches", () => {
    const result = runModule(
      `
      import assert from "node:assert/strict";
      import { Server } from ${JSON.stringify(builtModuleUrl("server"))};
      let requests = [];
      const before = { ...process.env };
      const engine = { execute: async (request) => {
        requests.push(request);
        return { cmd: [], exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      }};
      const server = new Server({ engine });
      assert.deepEqual({ ...process.env }, before);
      process.env.LIBTMUX_SOCKET_NAME = "changed";
      process.env.TMUX_TMPDIR = "/tmp/changed";
      process.env.TMUX = "/tmp/changed,1,0";
      const changed = { ...process.env };
      await server.cmd("display-message", ["-p", "test"]);
      assert.deepEqual({ ...process.env }, changed);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].globalArgs, ["-S" + server.socketPath]);
      assert.equal(server.socketPath, "/tmp/captured/tmux-" + process.getuid() + "/captured");
      assert.equal(Object.hasOwn(requests[0].environment, "TMUX"), false);
      assert.equal(Object.hasOwn(requests[0].environment, "TMUX_PANE"), false);
      console.log("captured");
    `,
      {
        ...process.env,
        LIBTMUX_SOCKET_PATH: "",
        LIBTMUX_SOCKET_NAME: "captured",
        TMUX_TMPDIR: "/tmp/captured",
        TMUX: "invalid-lower-priority",
        TMUX_PANE: "%3",
      },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("captured");
  });

  test("preserves seeded comma-rich TMUX paths and rejects corrupted suffixes", () => {
    let seed = 0x1a2b3c4d;
    for (let index = 0; index < 128; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const path = `/tmp/ltx-${String(seed)}, root,${String(index)}/socket `;
      const pid = String(seed + 1);
      expect(connect({ TMUX: `${path},${pid},$${String(index)}` }).socketPath).toBe(path);
      expect(() => connect({ TMUX: `${path},${pid},invalid` })).toThrow(TypeError);
    }
  });
});
