import { expect, test } from "bun:test";

import { daemonCondition } from "../../src/_internal/transport/daemon_guard.js";
import { snapshotInvocationRequest } from "../../src/_internal/transport/types.js";

test("ownership guard includes the generation after a numeric daemon collision", () => {
  const daemon = { pid: "123", startTime: "456", generation: "0123456789abcdef0123456789abcdef" };
  expect(daemonCondition(daemon)).toContain("#{@libtmux_owner_generation}");
  expect(daemonCondition(daemon)).toContain(daemon.generation);
});

test("transport snapshot retains and validates the generation", () => {
  const daemon = { pid: "123", startTime: "456", generation: "0123456789abcdef0123456789abcdef" };
  const request = {
    commands: [["kill-server"] as const] as const,
    daemonGuard: daemon,
    executable: "tmux",
    globalArgs: [],
  };
  expect(snapshotInvocationRequest(request).daemonGuard).toEqual(daemon);
  expect(() =>
    snapshotInvocationRequest({ ...request, daemonGuard: { ...daemon, generation: "bad" } }),
  ).toThrow();
});

test("malformed creation receipts expose uncertainty across a bounded input corpus", async () => {
  const { Server } = await import("../../src/server.js");
  const { ownSession, TmuxAcquisitionError } = await import("../../src/lifecycle.js");
  let seed = 0x7f12a50b;
  for (let index = 0; index < 48; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const valid = ["$1", "123", "456", "0123456789abcdef0123456789abcdef"];
    const invalid = ["@1", "0", "x", "f".repeat(seed % 31)];
    const part = seed % 4;
    valid[part] = invalid[part]!;
    const server = new Server({
      socketPath: "/tmp/ltx-parser-unused/socket",
      engine: {
        async execute(request) {
          const marker = /ltx-owned-[0-9a-f-]+/u.exec(request.commands.flat().join(" "))?.[0];
          if (marker === undefined) throw new Error("receipt parser sent a follow-up command");
          return {
            cmd: ["tmux"],
            exitCode: 0,
            signal: null,
            stderr: new Uint8Array(),
            stdout: new TextEncoder().encode(`${marker};${valid.join(";")}\n`),
          };
        },
      },
    });
    // eslint-disable-next-line no-await-in-loop -- Seeded corruption makes each refusal reproducible.
    const error = await ownSession(server).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TmuxAcquisitionError);
    expect((error as InstanceType<typeof TmuxAcquisitionError>).outcome).toBe("unknown");
    expect((error as InstanceType<typeof TmuxAcquisitionError>).receipt).toBeUndefined();
  }
});

test("malformed startup and partial mutation replies retain uncertain acquisition", async () => {
  const { Server } = await import("../../src/server.js");
  const { ownSession, findOrCreateServer, TmuxAcquisitionError } =
    await import("../../src/lifecycle.js");
  const { TmuxTransportError } = await import("../../src/errors.js");
  for (const startup of [false, true]) {
    let failure: Error | undefined;
    const server = new Server({
      socketPath: "/tmp/ltx-parser-unused/socket",
      engine: {
        async execute(request) {
          const marker = /ltx-(?:owned|start)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/u.exec(
            request.commands.flat().join(" "),
          )?.[0];
          const stdout = new TextEncoder().encode(
            `${marker}${startup ? "-created" : ""};${startup ? "server" : "$1"};123;456;invalid\n`,
          );
          if (!startup) {
            failure = new TmuxTransportError("lost partial reply", {
              delivery: "written",
              kind: "pipe",
              stdout,
            });
            throw failure;
          }
          return { cmd: ["tmux"], exitCode: 0, signal: null, stderr: new Uint8Array(), stdout };
        },
      },
    });
    // eslint-disable-next-line no-await-in-loop -- Each malformed reply exercises a different handoff.
    const error = await (startup ? findOrCreateServer(server) : ownSession(server)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TmuxAcquisitionError);
    expect((error as InstanceType<typeof TmuxAcquisitionError>).outcome).toBe("unknown");
    expect((error as InstanceType<typeof TmuxAcquisitionError>).receipt).toBeUndefined();
    if (failure !== undefined)
      expect(((error as Error).cause as AggregateError).errors).toContain(failure);
  }
});
