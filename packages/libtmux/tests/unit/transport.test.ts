import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { decodeBackslashReplace } from "../../src/_internal/codec/backslash_replace.js";
import {
  adaptRawResult,
  executeBatch,
  prepareCommandRequest,
} from "../../src/_internal/operations/request.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import {
  flattenInvocation,
  MAX_PACKED_ARGV_BYTES,
} from "../../src/_internal/transport/invocation.js";
import type { CommandRequest } from "../../src/_internal/transport/types.js";
import { TmuxTransportError } from "../../src/exc.js";

const echoFixture = fileURLToPath(new URL("../fixtures/echo_argv.mjs", import.meta.url));
const malformedFixture = fileURLToPath(new URL("../fixtures/malformed_utf8.mjs", import.meta.url));

describe("NodeSpawnTransport", () => {
  test("rejects invalid timer values before spawning", async () => {
    const invalidTimeout = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];
    const invalidDelay = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];

    await Promise.all(
      invalidTimeout.map((timeoutMs) =>
        expect(
          new NodeSpawnTransport().execute({
            commands: [["display-message"]],
            executable: "/definitely/not/an/executable",
            globalArgs: [],
            timeoutMs,
          }),
        ).rejects.toThrow(/timeoutMs/u),
      ),
    );
    for (const postKillGraceMs of invalidDelay) {
      expect(() => new NodeSpawnTransport({ postKillGraceMs })).toThrow(/postKillGraceMs/u);
    }
    for (const terminationGraceMs of invalidDelay) {
      expect(() => new NodeSpawnTransport({ terminationGraceMs })).toThrow(/terminationGraceMs/u);
    }
    expect(
      () => new NodeSpawnTransport({ postKillGraceMs: 0, terminationGraceMs: 0 }),
    ).not.toThrow();

    await expect(
      new NodeSpawnTransport().execute({
        commands: [
          ["display-message", "first"],
          ["display-message", "second"],
        ],
        executable: "/definitely/not/an/executable",
        globalArgs: [],
        timeoutMs: Number.NaN,
      }),
    ).rejects.toThrow(/timeoutMs/u);
  });

  test("passes hostile-looking values as distinct literal arguments", async () => {
    const values = ["with space", "-leading", 'a"quote', "a\\backslash", "雪"];
    const transport = new NodeSpawnTransport();
    const raw = await transport.execute({
      commands: [[echoFixture, ...values]],
      executable: process.execPath,
      globalArgs: [],
    });

    expect(JSON.parse(decodeBackslashReplace(raw.stdout))).toEqual(values);
    expect(raw.cmd).toEqual([process.execPath, echoFixture, ...values]);
    expect(raw.returncode).toBe(0);
  });

  test("returns raw bytes for nonzero exits instead of throwing", async () => {
    const transport = new NodeSpawnTransport();
    const raw = await transport.execute({
      commands: [[echoFixture, "--exit-code=7", "kept"]],
      executable: process.execPath,
      globalArgs: [],
    });

    expect(raw.returncode).toBe(7);
    expect(raw.stdout).toBeInstanceOf(Uint8Array);
    expect(raw.stderr).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(decodeBackslashReplace(raw.stdout))).toEqual(["kept"]);
  });

  test("drains stdout and stderr concurrently", async () => {
    const transport = new NodeSpawnTransport();
    const raw = await transport.execute({
      commands: [[echoFixture, "--dual-streams", "1048576"]],
      executable: process.execPath,
      globalArgs: [],
    });

    expect(raw.stdout.byteLength).toBe(1_048_576);
    expect(raw.stderr.byteLength).toBe(1_048_576);
  });

  test("terminates output beyond its retained-byte budget", async () => {
    expect(() => new NodeSpawnTransport({ maxOutputBytes: 0 })).toThrow(/maxOutputBytes/u);
    const transport = new NodeSpawnTransport({ maxOutputBytes: 1_024 });

    try {
      await transport.execute({
        commands: [[echoFixture, "--dual-streams", "1048576"]],
        executable: process.execPath,
        globalArgs: [],
      });
      throw new Error("expected the output budget to stop the command");
    } catch (error) {
      expect(error).toBeInstanceOf(TmuxTransportError);
      if (!(error instanceof TmuxTransportError)) throw error;
      expect(error).toMatchObject({ delivery: "indeterminate", kind: "protocol" });
      expect(error.stdout.byteLength + error.stderr.byteLength).toBeLessThanOrEqual(1_024);
    }
  });

  test("captures stdin bytes when execution begins", async () => {
    const stdin = Uint8Array.of(0x61, 0x62);
    const transport = new NodeSpawnTransport();

    const execution = transport.execute({
      commands: [[echoFixture, "--echo-stdin"]],
      executable: process.execPath,
      globalArgs: [],
      stdin,
    });
    stdin[0] = 0x7a;

    const raw = await execution;
    expect([...raw.stdout]).toEqual([0x61, 0x62]);
  });

  test("keeps submitted argv correlated with the raw result", async () => {
    const args: [string, string] = [echoFixture, "submitted"];
    const transport = new NodeSpawnTransport();

    const execution = transport.execute({
      commands: [args],
      executable: process.execPath,
      globalArgs: [],
    });
    args[1] = "mutated-after-spawn";

    const raw = await execution;
    expect(JSON.parse(decodeBackslashReplace(raw.stdout))).toEqual(["submitted"]);
    expect(raw.cmd).toEqual([process.execPath, echoFixture, "submitted"]);
  });

  test("adapts malformed bytes produced by a child", async () => {
    const transport = new NodeSpawnTransport();
    const raw = await transport.execute({
      commands: [[malformedFixture]],
      executable: process.execPath,
      globalArgs: [],
    });

    expect(adaptRawResult(raw).stdout).toEqual(["valid:€", "bad:\\xff\\xc3("]);
  });

  test("keeps command boundaries distinct from literal trailing semicolons", () => {
    expect(
      flattenInvocation({
        commands: [["display-message", "-p", "literal;"], ["list-sessions"]],
        executable: "tmux",
        globalArgs: ["-Ltest"],
      }),
    ).toEqual(["-Ltest", "display-message", "-p", "literal\\;", ";", "list-sessions"]);
  });

  test("rejects invalid invocation bytes and size before spawn", async () => {
    const transport = new NodeSpawnTransport();
    await expect(
      transport.execute({
        commands: [["bad\0command"]],
        executable: "/definitely/not/tmux",
        globalArgs: [],
      }),
    ).rejects.toMatchObject({ delivery: "not_started", kind: "protocol" });
    await expect(
      transport.execute({
        commands: [["display-message", "x".repeat(MAX_PACKED_ARGV_BYTES)]],
        executable: "/definitely/not/tmux",
        globalArgs: [],
      }),
    ).rejects.toBeInstanceOf(TmuxTransportError);
  });
});

describe("request preparation and batching", () => {
  test("prepares connection flags and caller arguments without shell syntax", () => {
    const connection = new TmuxConnection({
      colors: 88,
      configFile: "/tmp/tmux.conf",
      environment: { TERM: "screen-256color" },
      executable: "/usr/bin/tmux",
      socketPath: "/tmp/tmux.sock",
    });

    expect(prepareCommandRequest(connection, ["display-message", ";", "hello world"])).toEqual({
      commands: [["display-message", ";", "hello world"]],
      environment: { TERM: "screen-256color" },
      executable: "/usr/bin/tmux",
      globalArgs: ["-8", "-f/tmp/tmux.conf", "-S/tmp/tmux.sock"],
    });
  });

  test("rejects stdin for commands without a native stdin operand", () => {
    const connection = new TmuxConnection({ executable: "/usr/bin/tmux" });

    expect(() =>
      prepareCommandRequest(connection, ["display-message", "hello"], { stdin: "payload" }),
    ).toThrow("display-message does not accept stdin");
  });

  test("copies stdin accepted by load-buffer from its caller", () => {
    const connection = new TmuxConnection({ executable: "/usr/bin/tmux" });
    const input = Uint8Array.of(0x61, 0x62);

    const request = prepareCommandRequest(connection, ["load-buffer", "-"], { stdin: input });
    input[0] = 0x7a;

    expect(request.stdin).toEqual(Uint8Array.of(0x61, 0x62));
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.commands)).toBe(true);
    expect(Object.isFrozen(request.commands[0])).toBe(true);
  });

  test("does not expose writable prepared stdin", async () => {
    const connection = new TmuxConnection({ executable: "/usr/bin/tmux" });
    const request = prepareCommandRequest(connection, ["load-buffer", "-"], {
      stdin: Uint8Array.of(0x61, 0x62),
    });

    request.stdin![0] = 0x7a;
    await Promise.resolve();

    expect(request.stdin).toEqual(Uint8Array.of(0x61, 0x62));
  });

  test("returns correlated success failure success and continues after failure", async () => {
    const transport = new NodeSpawnTransport();
    const requests = [0, 9, 0].map<CommandRequest>((exitCode, index) => ({
      commands: [[echoFixture, `--exit-code=${exitCode}`, `request-${index}`]],
      executable: process.execPath,
      globalArgs: [],
    }));

    const outcomes = await executeBatch(transport, requests);

    expect(outcomes.map(({ index, status, delivery }) => ({ index, status, delivery }))).toEqual([
      { delivery: "replied", index: 0, status: "complete" },
      { delivery: "replied", index: 1, status: "failed" },
      { delivery: "replied", index: 2, status: "complete" },
    ]);
    expect(outcomes.map((outcome) => outcome.result?.returncode)).toEqual([0, 9, 0]);
    expect(outcomes.map((outcome) => outcome.request)).toEqual(requests);
  });

  test("captures the independent request sequence before awaiting", async () => {
    const transport = new NodeSpawnTransport();
    const secondRequest: CommandRequest = {
      commands: [[echoFixture, "second-original"]],
      executable: process.execPath,
      globalArgs: [],
    };
    const requests: CommandRequest[] = [
      { commands: [[echoFixture, "first"]], executable: process.execPath, globalArgs: [] },
      secondRequest,
    ];

    const execution = executeBatch(transport, requests);
    requests[1] = {
      commands: [[echoFixture, "second-replacement"]],
      executable: process.execPath,
      globalArgs: [],
    };
    const outcomes = await execution;

    expect(outcomes[1]?.request).not.toBe(secondRequest);
    expect(outcomes[1]?.request).toEqual(secondRequest);
    expect(Object.isFrozen(outcomes[1]?.request)).toBe(true);
    expect(JSON.parse(decodeBackslashReplace(outcomes[1]!.rawResult!.stdout))).toEqual([
      "second-original",
    ]);
  });

  test("captures every nested batch argv before awaiting", async () => {
    const transport = new NodeSpawnTransport();
    const secondArgs: [string, string] = [echoFixture, "second-original"];
    const requests: CommandRequest[] = [
      { commands: [[echoFixture, "first"]], executable: process.execPath, globalArgs: [] },
      { commands: [secondArgs], executable: process.execPath, globalArgs: [] },
    ];

    const execution = executeBatch(transport, requests);
    secondArgs[1] = "second-mutated";
    const outcomes = await execution;

    expect(outcomes[1]?.request.commands[0]).toEqual([echoFixture, "second-original"]);
    expect(JSON.parse(decodeBackslashReplace(outcomes[1]!.rawResult!.stdout))).toEqual([
      "second-original",
    ]);
    expect(outcomes[1]?.rawResult?.cmd).toEqual([process.execPath, echoFixture, "second-original"]);
  });

  test("captures every nested batch stdin before awaiting", async () => {
    const transport = new NodeSpawnTransport();
    const secondStdin = Uint8Array.of(0x61, 0x62);
    const requests: CommandRequest[] = [
      { commands: [[echoFixture, "first"]], executable: process.execPath, globalArgs: [] },
      {
        commands: [[echoFixture, "--echo-stdin"]],
        executable: process.execPath,
        globalArgs: [],
        stdin: secondStdin,
      },
    ];

    const execution = executeBatch(transport, requests);
    secondStdin[0] = 0x7a;
    const outcomes = await execution;

    expect(outcomes[1]?.request.stdin).toEqual(Uint8Array.of(0x61, 0x62));
    expect(outcomes[1]?.rawResult?.stdout).toEqual(Uint8Array.of(0x61, 0x62));
  });
});
