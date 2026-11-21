import { describe, expect, test } from "bun:test";

import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";
import { LibTmuxError, TmuxTransportError, VersionTooLowError } from "../../src/errors.js";
import { Server } from "../../src/server.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import {
  deriveTmuxCapabilities,
  LazyCapabilityBinding,
} from "../../src/_internal/runtime/capabilities.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";
import { singleCommandTransport } from "../support/transport_double.js";
import { answerVersionProbe, checkedEngine, probeMarker } from "../support/version_probe.js";

const encoder = new TextEncoder();

function alias(value: string): ConnectionAlias {
  return value as ConnectionAlias;
}

function epoch(value: number): DaemonEpoch {
  return value as DaemonEpoch;
}

function resultFor(request: CommandRequest, version: string): RawCommandResult {
  return answerVersionProbe(request, version);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve() {
      resolve?.();
    },
  };
}

/** Change the replying daemon without changing the Server or its socket. */
function discoveryFixture(version = "3.8") {
  const state = { version, identity: { pid: "101", startTime: "202" } };
  const requests: CommandRequest[] = [];
  const probes: CommandRequest[] = [];
  const server = new Server({
    socketName: "capability-report",
    engine: checkedEngine(
      async (request) => {
        requests.push(request);
        expect(request.commands).toEqual([["display-message", "-p", "ltxI#{pid};#{start_time}"]]);
        return {
          cmd: [request.executable, ...flattenInvocation(request)],
          exitCode: 0,
          signal: null,
          stderr: new Uint8Array(),
          stdout: encoder.encode(`ltxI${state.identity.pid};${state.identity.startTime}\n`),
        };
      },
      {
        probe(request) {
          probes.push(request);
          return answerVersionProbe(request, state.version, state.identity);
        },
      },
    ),
  });
  return { server, state, requests, probes };
}

describe("public capability discovery", () => {
  test.each([
    ["3.7c", false],
    ["next-3.8", false],
    ["3.8-rc2", false],
    ["3.8", true],
    ["3.8a", true],
  ] as const)("reports qualified program support on %s", async (version, supported) => {
    const { server, state, requests } = discoveryFixture(version);
    const report = await server.capabilities();
    expect(report.version).toBe(version);
    expect(report.minimumVersion).toBe("3.3a");
    expect(report.daemonIdentity).toEqual(state.identity);
    expect(report.features["program-run"].supported).toBe(supported);
    expect(report.features["program-run"].since).toBe("3.8");
    expect(report.features["program-run"].reason).toContain(version);
    expect(report.features["buffer-rename"].supported).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test("rechecks identity before returning cached capability decisions", async () => {
    const { server, state, probes } = discoveryFixture();
    const first = await server.capabilities();
    state.version = "3.7c";
    state.identity = { pid: "303", startTime: "404" };
    const second = await server.capabilities();
    expect(second.daemonIdentity).toEqual(state.identity);
    expect(second.features["program-run"].supported).toBe(false);
    expect(second.daemonEpoch).not.toBe(first.daemonEpoch);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(first.features["program-run"].supported).toBe(true);
    expect(probes).toHaveLength(2);
  });

  test("freezes nested metadata without exposing mutable admission rules", async () => {
    const { server } = discoveryFixture("3.3a");
    const report = await server.capabilities();
    const feature = report.features["program-run"];
    expect(Reflect.set(feature, "supported", true)).toBe(false);
    expect(Reflect.set(feature, "since", "3.3a")).toBe(false);
    expect(Reflect.set(feature.commands[0]!.flags!, "0", "-bad")).toBe(false);
    expect(Reflect.set(report.features, "program-run", {})).toBe(false);
    expect(Reflect.set(report.daemonIdentity, "pid", "999")).toBe(false);
    const next = await server.capabilities();
    expect(next.features["program-run"].supported).toBe(false);
    expect(next.features["program-run"].since).toBe("3.8");
    expect(next.workarounds["name-separators-rejected"].active).toBe(false);
    expect(next.workarounds["run-shell-output-in-copy-mode"].active).toBe(true);
  });

  test("refuses unknown versions and already-cancelled discovery", async () => {
    const unknown = discoveryFixture("unidentified-tmux");
    await expect(unknown.server.capabilities()).rejects.toThrow();
    expect(unknown.requests).toHaveLength(0);
    const cancelled = discoveryFixture();
    const abort = new AbortController();
    abort.abort();
    await expect(cancelled.server.capabilities({ signal: abort.signal })).rejects.toThrow();
    expect(cancelled.probes).toHaveLength(0);
    expect(cancelled.requests).toHaveLength(0);
  });
});

describe("tmux capabilities", () => {
  test("derives frozen capabilities that carry no per-release flags", () => {
    const capabilities = deriveTmuxCapabilities({
      connectionAlias: alias("daemon-a"),
      daemon: { pid: "101", startTime: "202" },
      daemonEpoch: epoch(1),
      rawVersion: "3.7",
    });

    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(capabilities).not.toHaveProperty("quirks");
  });

  test("fingerprints version, identity, connection alias, and daemon epoch", () => {
    const daemon = { pid: "101", startTime: "202" };
    const original = deriveTmuxCapabilities({
      connectionAlias: alias("daemon-a"),
      daemon,
      daemonEpoch: epoch(1),
      rawVersion: "3.7b",
    });
    const changedVersion = deriveTmuxCapabilities({
      connectionAlias: alias("daemon-a"),
      daemon,
      daemonEpoch: epoch(1),
      rawVersion: "3.7a",
    });
    const changedAlias = deriveTmuxCapabilities({
      connectionAlias: alias("daemon-b"),
      daemon,
      daemonEpoch: epoch(1),
      rawVersion: "3.7b",
    });
    const changedEpoch = deriveTmuxCapabilities({
      connectionAlias: alias("daemon-a"),
      daemon,
      daemonEpoch: epoch(2),
      rawVersion: "3.7b",
    });
    const changedDaemon = deriveTmuxCapabilities({
      connectionAlias: alias("daemon-a"),
      daemon: { pid: "303", startTime: "404" },
      daemonEpoch: epoch(1),
      rawVersion: "3.7b",
    });

    expect(
      new Set([
        original.fingerprint,
        changedVersion.fingerprint,
        changedAlias.fingerprint,
        changedDaemon.fingerprint,
        changedEpoch.fingerprint,
      ]).size,
    ).toBe(5);
    expect(
      deriveTmuxCapabilities({
        connectionAlias: alias("daemon-a"),
        daemon,
        daemonEpoch: epoch(1),
        rawVersion: "3.7b",
      }).fingerprint,
    ).toBe(original.fingerprint);
  });

  test("binds lazily against the connected daemon and caches one epoch", async () => {
    const requests: CommandRequest[] = [];
    const transport: CommandTransport = singleCommandTransport(async (request) => {
      requests.push(request);
      return resultFor(request, "3.6a");
    });
    const connection = new TmuxConnection({
      executable: "/usr/bin/tmux",
      socketPath: "/tmp/capability.sock",
    });
    let currentEpoch = epoch(9);
    const binding = new LazyCapabilityBinding({
      connection,
      connectionAlias: alias("connected-daemon"),
      getDaemonEpoch: () => currentEpoch,
      transport,
    });

    expect(requests).toHaveLength(0);
    const first = await binding.bind();
    const second = await binding.bind();

    expect(first).toBe(second);
    expect(first.daemon).toEqual({ pid: "101", startTime: "202" });
    expect(first.rawVersion).toBe("3.6a");
    expect(requests).toHaveLength(1);
    expect(flattenInvocation(requests[0]!)).toEqual([
      "-u",
      "-S/tmp/capability.sock",
      "-N",
      "run-shell",
      "-C",
      `${probeMarker(requests[0]!)}#{version}/#{pid}/#{start_time}`,
    ]);

    currentEpoch = epoch(10);
    const rebound = await binding.bind();
    expect(requests).toHaveLength(2);
    expect(rebound.daemonEpoch).toBe(currentEpoch);
    expect(rebound.fingerprint).not.toBe(first.fingerprint);
  });

  test("single-flights concurrent probes once per daemon epoch", async () => {
    let entered = deferred();
    let release = deferred();
    let requests = 0;
    const transport: CommandTransport = singleCommandTransport(async (request) => {
      requests += 1;
      entered.resolve();
      await release.promise;
      return resultFor(request, "3.7b");
    });
    let currentEpoch = epoch(20);
    const binding = new LazyCapabilityBinding({
      connection: new TmuxConnection({ executable: "/usr/bin/tmux", socketName: "single-flight" }),
      connectionAlias: alias("single-flight"),
      getDaemonEpoch: () => currentEpoch,
      transport,
    });

    const first = binding.bind();
    const second = binding.bind();
    await entered.promise;
    await Promise.resolve();
    const firstWaveRequests = requests;
    release.resolve();
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(firstWaveRequests).toBe(1);
    expect(firstSnapshot).toBe(secondSnapshot);

    currentEpoch = epoch(21);
    entered = deferred();
    release = deferred();
    const third = binding.bind();
    const fourth = binding.bind();
    await entered.promise;
    await Promise.resolve();
    const secondWaveRequests = requests;
    release.resolve();
    const [thirdSnapshot, fourthSnapshot] = await Promise.all([third, fourth]);
    expect(secondWaveRequests).toBe(2);
    expect(thirdSnapshot).toBe(fourthSnapshot);
    expect(thirdSnapshot).not.toBe(firstSnapshot);
  });

  test("keeps a shared probe alive for an uncancelled waiter", async () => {
    const entered = deferred();
    const release = deferred();
    let request: CommandRequest | undefined;
    const transport: CommandTransport = singleCommandTransport(async (current) => {
      request = current;
      entered.resolve();
      await release.promise;
      return resultFor(current, "3.7b");
    });
    const binding = new LazyCapabilityBinding({
      connection: new TmuxConnection({ executable: "/usr/bin/tmux", socketName: "shared-probe" }),
      connectionAlias: alias("shared-probe"),
      getDaemonEpoch: () => epoch(30),
      transport,
    });
    const controller = new AbortController();
    const cancelled = binding.bind(controller.signal);
    const waiting = binding.bind();

    await entered.promise;
    controller.abort();
    release.resolve();
    const outcomes = await Promise.allSettled([cancelled, waiting]);

    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);
    expect(request?.signal?.aborted).toBe(false);
  });

  test("joins the capability request after its last waiter cancels", async () => {
    const entered = deferred();
    const release = deferred();
    const aborted = deferred();
    let request: CommandRequest | undefined;
    const transport: CommandTransport = singleCommandTransport(async (current) => {
      request = current;
      entered.resolve();
      current.signal?.addEventListener("abort", aborted.resolve, { once: true });
      await release.promise;
      throw new TmuxTransportError("command cancelled", {
        delivery: "indeterminate",
        kind: "cancelled",
      });
    });
    const binding = new LazyCapabilityBinding({
      connection: new TmuxConnection({ executable: "/usr/bin/tmux", socketName: "last-waiter" }),
      connectionAlias: alias("last-waiter"),
      getDaemonEpoch: () => epoch(31),
      transport,
    });
    const controller = new AbortController();
    let outcome: unknown = "pending";
    const pending = binding.bind(controller.signal).catch((error: unknown) => {
      outcome = error;
      throw error;
    });

    try {
      await entered.promise;
      controller.abort();
      expect(request?.signal?.aborted).toBe(true);
      await aborted.promise;
      expect(outcome).toBe("pending");
      release.resolve();
      await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });

  test("rejects an epoch change during the daemon probe without caching it", async () => {
    let currentEpoch = epoch(4);
    let calls = 0;
    const transport: CommandTransport = singleCommandTransport(async (request) => {
      calls += 1;
      currentEpoch = epoch(5);
      return resultFor(request, "3.7b");
    });
    const binding = new LazyCapabilityBinding({
      connection: new TmuxConnection({ executable: "/usr/bin/tmux", socketName: "named" }),
      connectionAlias: alias("connected-daemon"),
      getDaemonEpoch: () => currentEpoch,
      transport,
    });

    await expect(binding.bind()).rejects.toThrow("daemon epoch changed while binding capabilities");
    expect(calls).toBe(1);
    await expect(binding.bind()).resolves.toMatchObject({ daemonEpoch: epoch(5) });
    expect(calls).toBe(2);
  });

  test.each(["3.2a", "3.3", "next-3.3a"])(
    "refuses to bind a %s daemon, whatever the client reports",
    async (version) => {
      const binding = new LazyCapabilityBinding({
        connection: new TmuxConnection({ executable: "/usr/bin/tmux" }),
        connectionAlias: alias("connected-daemon"),
        getDaemonEpoch: () => epoch(1),
        transport: singleCommandTransport(async (request) => resultFor(request, version)),
      });

      await expect(binding.bind()).rejects.toBeInstanceOf(VersionTooLowError);
      expect(binding.bound()).toBeUndefined();
    },
  );

  test("maps unreadable and failed connected-daemon capability replies", async () => {
    const replies = [
      {
        diagnostic: "cannot reach tmux: it exited with status 0",
        exitCode: 0,
        stderr: "",
      },
      {
        diagnostic: "cannot reach tmux: unknown command: something-else",
        exitCode: 1,
        stderr: "unknown command: something-else\n",
      },
      {
        diagnostic: "cannot reach tmux: no server running",
        exitCode: 1,
        stderr: "no server running\n",
      },
      {
        diagnostic: "cannot reach tmux: no server running on /tmp/capability.sock",
        exitCode: 1,
        stderr: "no server running on /tmp/capability.sock\n",
      },
    ];

    for (const reply of replies) {
      const requests: CommandRequest[] = [];
      const transport: CommandTransport = singleCommandTransport(async (request) => {
        requests.push(request);
        return {
          cmd: Object.freeze([request.executable, ...flattenInvocation(request)]),
          exitCode: reply.exitCode,
          signal: null,
          stderr: encoder.encode(reply.stderr),
          stdout: new Uint8Array(),
        };
      });
      const binding = new LazyCapabilityBinding({
        connection: new TmuxConnection({ executable: "/usr/bin/tmux" }),
        connectionAlias: alias("connected-daemon"),
        getDaemonEpoch: () => epoch(1),
        transport,
      });

      let probeError: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop -- each complete reply exercises a distinct protocol failure.
        await binding.bind();
      } catch (error) {
        probeError = error;
      }
      expect(requests).toHaveLength(1);
      expect(probeMarker(requests[0]!)).toBeDefined();
      expect(probeError).toBeInstanceOf(LibTmuxError);
      expect((probeError as Error).message).toContain(reply.diagnostic);
    }
  });
});
