import { link, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { Server } from "../../src/server.js";
import type { CommandOptions } from "../../src/common.js";
import type { Session } from "../../src/session.js";
import type { Window } from "../../src/window.js";
import type { FindOrCreateResult } from "../../src/lifecycle.js";
import {
  adoptServer,
  adoptSession,
  adoptWindow,
  adoptPane,
  ownSession,
  ownWindow,
  ownPane,
  findOrCreateServer,
  findOrCreateSession,
  findOrCreateWindow,
  findOrCreatePane,
  withOwned,
  TmuxAcquisitionError,
} from "../../src/lifecycle.js";
import {
  TmuxTransportError,
  TmuxServerRestartedError,
  MultipleMatchesError,
} from "../../src/errors.js";
import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import {
  assertOwnedSocketPath,
  readDaemonIdentity,
  makeTestDirectory,
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
} from "../../src/_internal/test/testkit.js";
import { waitForProcessExit } from "../support/converge.js";
import { killExactTmux, launchExactTmux } from "../support/tmux_cleanup.js";
import { isColdEndpoint } from "../../src/_internal/operations/command.js";
import type { TmuxInvocationRequest, TmuxCommandResult } from "../../src/engine.js";

async function withFixture(
  body: (server: Server, fixture: TestServer) => Promise<void>,
): Promise<void> {
  const parent = await makeTestDirectory("ltx-life-");
  const runRoot = join(parent, "run");
  await prepareRunRoot(runRoot);
  let fixture: TestServer | undefined;
  let cleaned = false;
  try {
    await runWithCleanup(
      async () => {
        fixture = await TestServer.create({ runRoot, sessionName: "keep" });
        assertOwnedSocketPath(fixture.socketPath);
        const server = new Server({
          socketPath: fixture.socketPath,
          environment: fixture.controllerEnvironment,
          tmuxBin: fixture.tmuxExecutable,
        });
        await body(server, fixture);
      },
      async () => {
        await fixture?.dispose();
        if (fixture !== undefined) await waitForProcessExit(fixture.daemonIdentity.pid);
        await reapOwnedRunRoot(runRoot);
        cleaned = true;
      },
    );
  } finally {
    if (cleaned) await rm(parent, { recursive: true, force: true });
  }
}

function intercept(
  server: Server,
  body: (
    request: TmuxInvocationRequest,
    next: () => Promise<TmuxCommandResult>,
  ) => Promise<TmuxCommandResult>,
  environment?: Readonly<Record<string, string | undefined>>,
): Server {
  const transport = new NodeSpawnTransport();
  return new Server({
    socketPath: server.socketPath!,
    tmuxBin: server.tmuxBin,
    ...(server.configFile === undefined ? {} : { configFile: server.configFile }),
    ...(environment === undefined ? {} : { environment }),
    engine: {
      execute(request) {
        return body(request, () => transport.execute(request));
      },
    },
  });
}

function carries(request: TmuxInvocationRequest, text: string): boolean {
  return request.commands.flat().some((part) => part.includes(text));
}

describe("owned tmux lifecycle", () => {
  test("creates a session with a receipt and repeats successful disposal harmlessly", async () => {
    await withFixture(async (server) => {
      const owned = await ownSession(server, { name: "owned" });
      expect(owned.receipt.daemon.generation).toMatch(/^[0-9a-fA-F]{32}$/u);
      expect(owned.receipt.id).toBe(owned.value.id);
      expect((await server.snapshot()).sessions.exists({ id: owned.value.id })).toBe(true);
      await Promise.all([owned.dispose(), owned.dispose()]);
      await owned.dispose();
      expect(owned.state).toEqual({ status: "cleaned", attempts: 1 });
      expect((await server.snapshot()).sessions.exists({ id: owned.value.id })).toBe(false);
    });
  }, 30_000);
});

test("lookup, release, and client connection disposal retain remote objects", async () => {
  await withFixture(async (server) => {
    const borrowed = (await server.snapshot()).sessions.one();
    await server.withConnection(async (connected) => {
      expect((await connected.snapshot()).sessions.exists({ id: borrowed.id })).toBe(true);
    });
    expect((await server.snapshot()).sessions.exists({ id: borrowed.id })).toBe(true);
    const owner = await adoptSession(server, borrowed.id);
    expect(owner.release().id).toBe(borrowed.id);
    await owner.dispose();
    expect(owner.state.status).toBe("released");
    expect((await server.snapshot()).sessions.exists({ id: borrowed.id })).toBe(true);
  });
}, 30_000);

test("adopts each child type and keeps IDs through rename, move and links", async () => {
  await withFixture(async (server) => {
    const source = await server.newSession({ name: "source" });
    const target = await server.newSession({ name: "target" });
    const sessionOwner = await adoptSession(server, source.id);
    await source.rename("renamed");
    const createdWindow = await ownWindow(source, { name: "moving" });
    const window = createdWindow.release();
    const windowOwner = await adoptWindow(server, window.id);
    const pane = await window.split();
    const paneOwner = await adoptPane(server, pane.id);
    await pane.joinTo(target.windows.one().id);
    await paneOwner.dispose();
    expect((await server.snapshot()).panes.exists({ id: pane.id })).toBe(false);
    await window.move({ session: target.id });
    await window.link({ session: source.id });
    expect(
      (await server.snapshot()).windows.filter((candidate) => candidate.id === window.id).count(),
    ).toBe(2);
    await windowOwner.dispose();
    expect(
      (await server.snapshot()).windows.filter((candidate) => candidate.id === window.id).count(),
    ).toBe(0);
    await sessionOwner.dispose();
    const snapshot = await server.snapshot();
    expect(snapshot.sessions.exists({ id: source.id })).toBe(false);
    expect(snapshot.sessions.exists({ id: target.id })).toBe(true);
  });
}, 30_000);

test("preserves an existing token and refuses empty or malformed reserved metadata", async () => {
  await withFixture(async (server) => {
    const token = "ABCDEF0123456789abcdef0123456789";
    await server.setOption("@libtmux_owner_generation", token);
    const owner = await ownSession(server, { name: "valid-token" });
    expect(owner.receipt.daemon.generation).toBe(token);
    await owner.dispose();
    for (const value of ["", "0".repeat(31), "0".repeat(33), `${"0".repeat(31)}z`, "\n"]) {
      // eslint-disable-next-line no-await-in-loop -- Each malformed value is tested against the same reserved slot.
      await server.setOption("@libtmux_owner_generation", value);
      // eslint-disable-next-line no-await-in-loop -- A rejected generation must precede creation.
      await expect(ownSession(server, { name: "must-not-create" })).rejects.toThrow(
        "invalid-owner-generation",
      );
      // eslint-disable-next-line no-await-in-loop -- Verify the real daemon after each rejection.
      expect((await server.snapshot()).sessions.exists({ name: "must-not-create" })).toBe(false);
      // eslint-disable-next-line no-await-in-loop -- -o must leave malformed values intact.
      expect((await server.showOptions()).get("@libtmux_owner_generation")).toBe(value);
    }
  });
}, 30_000);

test("normal and exceptional scopes dispose without a body's aborted signal", async () => {
  await withFixture(async (server) => {
    const controller = new AbortController();
    const owner = await ownSession(server, { signal: controller.signal });
    const reason = new Error("body cancelled");
    await expect(
      withOwned(owner, async () => {
        controller.abort(reason);
        throw reason;
      }),
    ).rejects.toBe(reason);
    expect(owner.state.status).toBe("cleaned");
    expect((await server.snapshot()).sessions.exists({ id: owner.value.id })).toBe(false);
    const normal = await ownSession(server);
    expect(await withOwned(normal, async () => "done")).toBe("done");
    expect(normal.state.status).toBe("cleaned");
  });
}, 30_000);

test("failed cleanup is visible, preserves body failure, and retries", async () => {
  await withFixture(async (server) => {
    let fail = true;
    const cleanupFailure = new TmuxTransportError("injected cleanup", {
      delivery: "not_started",
      kind: "spawn",
    });
    const wired = intercept(server, async (request, next) => {
      if (fail && carries(request, "kill-session")) throw cleanupFailure;
      return next();
    });
    const owner = await ownSession(wired);
    const bodyFailure = new Error("body failed");
    const error = await withOwned(owner, async () => {
      throw bodyFailure;
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([bodyFailure, cleanupFailure]);
    expect(owner.state).toEqual({
      status: "failed",
      attempts: 1,
      error: cleanupFailure,
      delivery: "not_started",
    });
    expect((await server.snapshot()).sessions.exists({ id: owner.value.id })).toBe(true);
    fail = false;
    await owner.dispose();
    expect(owner.state).toEqual({ status: "cleaned", attempts: 2 });
  });
}, 30_000);

test("uncertain cleanup retains delivery and retries by guarded absence", async () => {
  await withFixture(async (server) => {
    let hide = true;
    const wired = intercept(server, async (request, next) => {
      const result = await next();
      if (hide && carries(request, "kill-session")) {
        hide = false;
        throw new TmuxTransportError("reply lost", { delivery: "written", kind: "pipe" });
      }
      return result;
    });
    const owner = await ownSession(wired);
    await expect(owner.dispose()).rejects.toMatchObject({ delivery: "written" });
    expect(owner.state.status).toBe("failed");
    expect((await server.snapshot()).sessions.exists({ id: owner.value.id })).toBe(false);
    await owner.dispose();
    expect(owner.state).toEqual({ status: "cleaned", attempts: 2 });
  });
}, 30_000);

for (const failure of ["cancel", "readback", "partial-reply"] as const) {
  test(`rolls back a known creation ID after ${failure}`, async () => {
    await withFixture(async (server) => {
      const controller = new AbortController();
      let didCreate = false;
      let failed = false;
      const wired = intercept(server, async (request, next) => {
        if (didCreate && !failed && failure === "readback") {
          failed = true;
          throw new Error("readback failed");
        }
        const result = await next();
        if (carries(request, "new-session") && !didCreate) {
          didCreate = true;
          if (failure === "cancel") controller.abort(new Error("cancelled at handoff"));
          if (failure === "partial-reply")
            throw new TmuxTransportError("partial receipt", {
              delivery: "written",
              kind: "pipe",
              stdout: result.stdout,
            });
        }
        return result;
      });
      const error = await ownSession(wired, {
        name: "rolled-back",
        signal: controller.signal,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TmuxAcquisitionError);
      expect((error as TmuxAcquisitionError).outcome).toBe("rolled_back");
      expect((error as TmuxAcquisitionError).receipt?.id).toMatch(/^\$\d+$/u);
      expect((await server.snapshot()).sessions.exists({ name: "rolled-back" })).toBe(false);
    });
  }, 30_000);
}

test("rollback failure retains both errors and exposes a retry", async () => {
  await withFixture(async (server) => {
    let createdRemote = false;
    let failReadback = true;
    let failCleanup = true;
    const wired = intercept(server, async (request, next) => {
      if (createdRemote && failReadback) {
        failReadback = false;
        throw new Error("readback failed");
      }
      if (failCleanup && carries(request, "kill-session")) throw new Error("rollback failed");
      const result = await next();
      if (carries(request, "new-session")) createdRemote = true;
      return result;
    });
    const caught = await ownSession(wired, { name: "needs-rollback" }).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(TmuxAcquisitionError);
    const error = caught as TmuxAcquisitionError;
    expect(error.outcome).toBe("rollback_failed");
    expect(error.cause).toMatchObject({ cause: { message: "readback failed" } });
    expect(error.cleanupError).toMatchObject({ message: "rollback failed" });
    expect((await server.snapshot()).sessions.exists({ name: "needs-rollback" })).toBe(true);
    failCleanup = false;
    await error.retryCleanup();
    expect((await server.snapshot()).sessions.exists({ name: "needs-rollback" })).toBe(false);
  });
}, 30_000);

test("unknown creation result does not guess an object or claim cleanup", async () => {
  await withFixture(async (server) => {
    const wired = intercept(server, async (request, next) => {
      const result = await next();
      if (carries(request, "new-session"))
        throw new TmuxTransportError("lost creation reply", {
          delivery: "indeterminate",
          kind: "pipe",
        });
      return result;
    });
    const caught = await ownSession(wired, { name: "unknown" }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TmuxAcquisitionError);
    const error = caught as TmuxAcquisitionError;
    expect(error.outcome).toBe("unknown");
    expect(error.receipt).toBeUndefined();
    await expect(error.retryCleanup()).rejects.toThrow("no known resource");
    expect((await server.snapshot()).sessions.exists({ name: "unknown" })).toBe(true);
  });
}, 30_000);

test("a stale server owner refuses a real replacement even with numeric identity collision", async () => {
  await withFixture(async (server, fixture) => {
    let collision: { pid: string; startTime: string } | undefined;
    const transport = new NodeSpawnTransport();
    const wired = new Server({
      socketPath: fixture.socketPath,
      engine: {
        execute(request) {
          return transport.execute(
            collision === undefined || request.daemonGuard === undefined
              ? request
              : { ...request, daemonGuard: { ...request.daemonGuard, ...collision } },
          );
        },
      },
    });
    const stale = await adoptServer(wired);
    await server.kill();
    await waitForProcessExit(fixture.daemonIdentity.pid);
    const pid = await launchExactTmux(fixture.socketPath, fixture.tmuxExecutable);
    try {
      const replacement = new Server({ socketPath: fixture.socketPath });
      const accepted = await adoptServer(replacement);
      accepted.release();
      collision = await replacement.daemonIdentity();
      expect(accepted.receipt.daemon.generation).not.toBe(stale.receipt.daemon.generation);
      await expect(stale.dispose()).rejects.toBeInstanceOf(TmuxServerRestartedError);
      expect(stale.state.status).toBe("failed");
      expect((await replacement.snapshot()).sessions.count()).toBe(1);
    } finally {
      if ((await readDaemonIdentity(pid)) !== undefined)
        await killExactTmux(fixture.socketPath, pid);
    }
    await waitForProcessExit(pid);
  });
}, 30_000);

async function withEmptyEndpoint(body: (server: Server) => Promise<void>): Promise<void> {
  const root = await makeTestDirectory("ltx-start-");
  const socketPath = join(root, "socket");
  assertOwnedSocketPath(socketPath);
  const server = new Server({ socketPath, configFile: "/dev/null" });
  let clean = false;
  try {
    await runWithCleanup(
      () => body(server),
      async () => {
        let pid: number | undefined;
        try {
          pid = Number((await server.daemonIdentity()).pid);
        } catch (error) {
          if (!isColdEndpoint(error)) throw error;
        }
        if (pid !== undefined) {
          await killExactTmux(socketPath, pid);
          await waitForProcessExit(pid);
        }
        clean = true;
      },
    );
  } finally {
    if (clean) await rm(root, { recursive: true, force: true });
  }
}

test("server find-or-create proves one starter under concurrent calls and borrows reuse", async () => {
  await withEmptyEndpoint(async (server) => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => findOrCreateServer(server, { name: "bootstrap" })),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(3);
    expect(results.every((result) => result.value.socketPath === server.socketPath)).toBe(true);
    const first = results.find((result) => result.created)!;
    expect("owner" in results.find((result) => !result.created)!).toBe(false);
    if (!first.created) throw new Error("expected startup owner");
    const pid = Number(first.owner.receipt.daemon.pid);
    await first.owner.dispose();
    await waitForProcessExit(pid);
    expect(await server.isAlive()).toBe(false);
  });
}, 30_000);

test("server find-or-create does not adopt a daemon another Server started", async () => {
  await withEmptyEndpoint(async (server) => {
    const other = new Server({ socketPath: server.socketPath!, configFile: "/dev/null" });
    const results = await Promise.all([findOrCreateServer(server), findOrCreateServer(other)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const result = results.find((candidate) => candidate.created)!;
    if (!result.created) throw new Error("missing startup owner");
    const pid = Number(result.owner.receipt.daemon.pid);
    await result.owner.dispose();
    await waitForProcessExit(pid);
  });
}, 30_000);

test("server find-or-create reports startup failure without a false owner", async () => {
  await withEmptyEndpoint(async (server) => {
    const controller = new AbortController();
    controller.abort();
    await expect(findOrCreateServer(server, { signal: controller.signal })).rejects.toMatchObject({
      delivery: "not_started",
    });
    expect(await server.isAlive()).toBe(false);
  });
}, 30_000);

test("find-or-create sessions, windows, and panes serialize on their documented parent", async () => {
  await withFixture(async (server) => {
    const sessions = await Promise.all(
      Array.from({ length: 3 }, () => findOrCreateSession(server, "work")),
    );
    expect(sessions.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(sessions.map((result) => result.value.id)).size).toBe(1);
    const session = sessions[0]!.value;
    const windows = await Promise.all(
      Array.from({ length: 3 }, () => findOrCreateWindow(session, "worker")),
    );
    expect(windows.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(windows.map((result) => result.value.id)).size).toBe(1);
    const window = windows[0]!.value;
    const identity = { option: "@application_role", value: "worker" };
    const panes = await Promise.all(
      Array.from({ length: 3 }, () => findOrCreatePane(window, identity)),
    );
    expect(panes.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(panes.map((result) => result.value.id)).size).toBe(1);
    const reused = await findOrCreatePane(window, identity);
    expect(reused.created).toBe(false);
    expect("owner" in reused).toBe(false);
  });
}, 30_000);

test("ambiguous windows and pane identities fail instead of choosing one", async () => {
  await withFixture(async (server) => {
    const session = (await server.snapshot()).sessions.one();
    await session.newWindow({ name: "duplicate" });
    await session.newWindow({ name: "duplicate" });
    await expect(findOrCreateWindow(session, "duplicate")).rejects.toBeInstanceOf(
      MultipleMatchesError,
    );
    const window = await session.newWindow();
    const one = await findOrCreatePane(window, { option: "@role", value: "same" });
    const two = await ownPane(window);
    await two.value.setOption("@role", "same");
    await expect(
      findOrCreatePane(window, { option: "@role", value: "same" }),
    ).rejects.toBeInstanceOf(MultipleMatchesError);
    expect((await server.snapshot()).panes.exists({ id: one.value.id })).toBe(true);
  });
}, 30_000);

test("child find-or-create surfaces failures and rolls back a failed pane identity write", async () => {
  await withFixture(async (server) => {
    await expect(findOrCreateSession(server, "bad:name")).rejects.toThrow();
    const session = (await server.snapshot()).sessions.one();
    await expect(findOrCreateWindow(session, "bad:name")).rejects.toThrow();
    await expect(
      findOrCreatePane(session.windows.one(), {
        option: "@libtmux_owner_generation",
        value: "bad",
      }),
    ).rejects.toThrow();
    let failWrite = true;
    const wired = intercept(server, async (request, next) => {
      if (failWrite && carries(request, "@fail_identity") && carries(request, "set-option"))
        throw new Error("identity write failed");
      return next();
    });
    const window = (await wired.snapshot()).windows.one();
    const initial = (await server.snapshot()).panes.count();
    await expect(
      findOrCreatePane(window, { option: "@fail_identity", value: "worker" }),
    ).rejects.toMatchObject({ outcome: "rolled_back" });
    expect((await server.snapshot()).panes.count()).toBe(initial);
    failWrite = false;
    const result = await findOrCreatePane(window, { option: "@fail_identity", value: "worker" });
    expect(result.created).toBe(true);
  });
}, 30_000);

for (const kind of ["window", "pane"] as const) {
  test(`owned ${kind} creation rolls back a readback failure`, async () => {
    await withFixture(async (server) => {
      let createdRemote = false;
      let fail = true;
      const wired = intercept(server, async (request, next) => {
        if (createdRemote && fail) {
          fail = false;
          throw new Error("readback failed");
        }
        const result = await next();
        if (carries(request, kind === "window" ? "new-window" : "split-window"))
          createdRemote = true;
        return result;
      });
      const session = (await wired.snapshot()).sessions.one();
      const before = await server.snapshot();
      const result = kind === "window" ? ownWindow(session) : ownPane(session.windows.one());
      await expect(result).rejects.toMatchObject({ outcome: "rolled_back" });
      const after = await server.snapshot();
      expect(after.windows.count()).toBe(before.windows.count());
      expect(after.panes.count()).toBe(before.panes.count());
    });
  }, 30_000);
}

test("adoption rolls back its received receipt when cancellation wins the handoff", async () => {
  await withFixture(async (server) => {
    const session = await server.newSession({ name: "adopt-and-cancel" });
    const controller = new AbortController();
    const wired = intercept(server, async (request, next) => {
      const result = await next();
      if (carries(request, "ltx-adopt-")) controller.abort(new Error("cancel adoption"));
      return result;
    });
    await expect(
      adoptSession(wired, session.id, { signal: controller.signal }),
    ).rejects.toMatchObject({ outcome: "rolled_back" });
    expect((await server.snapshot()).sessions.exists({ id: session.id })).toBe(false);
  });
}, 30_000);

test("creation readback never pairs the old ID with a replacement generation", async () => {
  await withFixture(async (server, fixture) => {
    let replacementPid: number | undefined;
    let replaced = false;
    const wired = intercept(server, async (request, next) => {
      const result = await next();
      if (!replaced && carries(request, "new-session")) {
        replaced = true;
        await server.kill();
        await waitForProcessExit(fixture.daemonIdentity.pid);
        replacementPid = await launchExactTmux(fixture.socketPath, fixture.tmuxExecutable);
        const replacement = new Server({ socketPath: fixture.socketPath });
        const accepted = await adoptServer(replacement);
        accepted.release();
        await replacement.newSession({ name: "replacement-collision" });
      }
      return result;
    });
    try {
      const caught = await ownSession(wired, { name: "old-creation" }).catch(
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(TmuxAcquisitionError);
      const error = caught as TmuxAcquisitionError;
      expect(error.outcome).toBe("rollback_failed");
      expect(error.cleanupError).toBeInstanceOf(TmuxServerRestartedError);
      expect(error.receipt?.id).toBe("$1");
      const replacement = new Server({ socketPath: fixture.socketPath });
      const snapshot = await replacement.snapshot();
      expect(String(snapshot.sessions.one({ name: "replacement-collision" }).id)).toBe("$1");
      expect(snapshot.sessions.count()).toBe(2);
    } finally {
      if (replacementPid !== undefined) {
        await killExactTmux(fixture.socketPath, replacementPid);
        await waitForProcessExit(replacementPid);
      }
    }
  });
}, 30_000);

for (const failure of ["cancel", "lost-reply"] as const) {
  test(`server startup handoff handles ${failure} without guessing ownership`, async () => {
    let startedPid: number | undefined;
    await withEmptyEndpoint(async (server) => {
      const controller = new AbortController();
      const wired = intercept(server, async (request, next) => {
        const result = await next();
        if (carries(request, "ltx-start-")) {
          startedPid = Number((await server.daemonIdentity()).pid);
          if (failure === "cancel") controller.abort(new Error("cancelled startup handoff"));
          else
            throw new TmuxTransportError("startup reply lost", {
              delivery: "indeterminate",
              kind: "pipe",
            });
        }
        return result;
      });
      const error = await findOrCreateServer(wired, { signal: controller.signal }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TmuxAcquisitionError);
      expect((error as TmuxAcquisitionError).outcome).toBe(
        failure === "cancel" ? "rolled_back" : "unknown",
      );
      expect(startedPid).toBeDefined();
      if (failure === "cancel") {
        await waitForProcessExit(startedPid!);
        expect(await server.isAlive()).toBe(false);
      } else {
        expect((error as TmuxAcquisitionError).receipt).toBeUndefined();
        expect((await server.snapshot()).sessions.count()).toBe(1);
      }
    });
    await waitForProcessExit(startedPid!);
  }, 30_000);
}

function cLocaleEnvironment(): Readonly<Record<string, string | undefined>> {
  return { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" };
}

test("C-locale ownership preserves identity receipts, names and socket paths", async () => {
  await withFixture(async (plain, fixture) => {
    const alias = join(dirname(fixture.socketPath), "socket; with space, comma");
    await link(fixture.socketPath, alias);
    try {
      const server = new Server({
        socketPath: alias,
        tmuxBin: fixture.tmuxExecutable,
        environment: cLocaleEnvironment(),
      });
      const daemon = await plain.daemonIdentity();
      const accepted = await adoptServer(server);
      expect(accepted.receipt.socketPath).toBe(alias);
      expect(accepted.receipt.daemon).toMatchObject(daemon);
      accepted.release();
      const token = accepted.receipt.daemon.generation;
      const verify = (receipt: { socketPath: string; daemon: unknown; id: string | undefined }) => {
        expect(receipt.socketPath).toBe(alias);
        expect(receipt.daemon).toEqual({ ...daemon, generation: token });
      };
      const session = await ownSession(server, { name: "session; with space, comma" });
      verify(session.receipt);
      expect(session.value.name).toBe("session; with space, comma");
      const adoptedSession = await adoptSession(server, session.value.id);
      verify(adoptedSession.receipt);
      adoptedSession.release();
      const window = await ownWindow(session.value, { name: "window; with space, comma" });
      verify(window.receipt);
      expect(window.value.name).toBe("window; with space, comma");
      const adoptedWindow = await adoptWindow(server, window.value.id);
      verify(adoptedWindow.receipt);
      adoptedWindow.release();
      const pane = await ownPane(window.value);
      verify(pane.receipt);
      const adoptedPane = await adoptPane(server, pane.value.id);
      verify(adoptedPane.receipt);
      adoptedPane.release();
      const reused = await findOrCreateServer(server);
      expect(reused.created).toBe(false);
      expect("owner" in reused).toBe(false);
      await pane.dispose();
      await window.dispose();
      await session.dispose();
      expect((await plain.snapshot()).sessions.count()).toBe(1);
    } finally {
      await rm(alias, { force: true });
    }
  });
}, 30_000);

test("C-locale server startup receives one owner and leaves reuse borrowed", async () => {
  await withEmptyEndpoint(async (plain) => {
    const server = new Server({
      socketPath: plain.socketPath!,
      configFile: "/dev/null",
      tmuxBin: plain.tmuxBin,
      environment: cLocaleEnvironment(),
    });
    const first = await findOrCreateServer(server, { name: "bootstrap; with space, comma" });
    expect(first.created).toBe(true);
    if (!first.created) throw new Error("missing startup owner");
    const identity = await plain.daemonIdentity();
    expect(first.owner.receipt.daemon).toMatchObject(identity);
    expect(first.owner.receipt.daemon.generation).toMatch(/^[0-9a-fA-F]{32}$/u);
    const second = await findOrCreateServer(server);
    expect(second.created).toBe(false);
    expect("owner" in second).toBe(false);
    await first.owner.dispose();
    await waitForProcessExit(Number(identity.pid));
  });
}, 30_000);

for (const mode of ["exit77", "partial", "cancel"] as const) {
  for (const kind of ["server", "session", "window", "pane"] as const) {
    test(`C-locale ${kind} acquisition rolls back a received receipt after ${mode}`, async () => {
      const body = async (plain: Server): Promise<void> => {
        const controller = new AbortController();
        const reason = new Error("cancel after C-locale receipt");
        let rawReceipt: readonly string[] = [];
        let initialError: TmuxTransportError | undefined;
        let armed = true;
        const server = intercept(
          plain,
          async (request, next) => {
            const result = await next();
            if (armed && (carries(request, "ltx-owned-") || carries(request, "ltx-start-"))) {
              armed = false;
              rawReceipt = new TextDecoder().decode(result.stdout).trim().split(";");
              if (mode === "exit77")
                return {
                  ...result,
                  exitCode: 77,
                  stderr: new TextEncoder().encode("after receipt"),
                };
              if (mode === "partial") {
                initialError = new TmuxTransportError("partial C-locale receipt", {
                  delivery: "written",
                  kind: "pipe",
                  stdout: result.stdout,
                });
                throw initialError;
              }
              controller.abort(reason);
            }
            return result;
          },
          cLocaleEnvironment(),
        );
        const before = kind === "server" ? undefined : await plain.snapshot();
        const session = kind === "server" ? undefined : (await server.snapshot()).sessions.one();
        const options = { signal: controller.signal };
        const operation =
          kind === "server"
            ? findOrCreateServer(server, options)
            : kind === "session"
              ? ownSession(server, options)
              : kind === "window"
                ? ownWindow(session!, options)
                : ownPane(session!.windows.one(), options);
        const caught = await operation.catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(TmuxAcquisitionError);
        const error = caught as TmuxAcquisitionError;
        expect(error.outcome).toBe("rolled_back");
        expect(error.receipt).toEqual({
          kind,
          id: kind === "server" ? undefined : rawReceipt[1],
          socketPath: plain.socketPath!,
          daemon: { pid: rawReceipt[2]!, startTime: rawReceipt[3]!, generation: rawReceipt[4]! },
        });
        expect(error.receipt!.daemon.generation).toMatch(/^[0-9a-fA-F]{32}$/u);
        if (mode === "partial") expect(error.cause).toBe(initialError);
        if (mode === "exit77") expect(error.cause).toMatchObject({ exitCode: 77 });
        if (mode === "cancel") expect((error.cause as TmuxTransportError).cause).toBe(reason);
        if (before === undefined) await waitForProcessExit(Number(error.receipt!.daemon.pid));
        else {
          const after = await plain.snapshot();
          expect(after.sessions.count()).toBe(before.sessions.count());
          expect(after.windows.count()).toBe(before.windows.count());
          expect(after.panes.count()).toBe(before.panes.count());
        }
      };
      if (kind === "server") await withEmptyEndpoint(body);
      else await withFixture(body);
    }, 30_000);
  }
}

async function withinCancellationBound<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function findExisting(
  kind: "server" | "session" | "window" | "pane",
  server: Server,
  session: Session,
  window: Window,
  options: CommandOptions = {},
): Promise<FindOrCreateResult<unknown>> {
  if (kind === "server") return findOrCreateServer(server, options);
  if (kind === "session") return findOrCreateSession(server, "keep", options);
  if (kind === "window") return findOrCreateWindow(session, window.name!, options);
  return findOrCreatePane(window, { option: "@repair_role", value: "keep" }, options);
}

for (const kind of ["server", "session", "window", "pane"] as const) {
  test(`cancelled queued ${kind} request settles promptly without advancing a third request`, async () => {
    await withFixture(async (plain) => {
      const channel = `repair-${randomUUID()}`;
      const transport = new NodeSpawnTransport();
      let enter: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let armed = false;
      let dispatches = 0;
      const server = intercept(plain, async (request, next) => {
        if (armed) {
          dispatches += 1;
          if (dispatches === 1) {
            enter();
            return transport.execute({
              ...request,
              commands: [["wait-for", channel], ...request.commands],
            });
          }
        }
        return next();
      });
      const session = (await server.snapshot()).sessions.one();
      const window = session.windows.one();
      await window.panes.one().setOption("@repair_role", "keep");
      const invoke = (options: CommandOptions = {}) =>
        findExisting(kind, server, session, window, options);
      armed = true;
      const first = invoke();
      await entered;
      const controller = new AbortController();
      const reason = new Error("queued request aborted");
      const second = invoke({ signal: controller.signal }).catch((error: unknown) => error);
      let thirdFinished = false;
      const third = invoke().then((result) => {
        thirdFinished = true;
        return result;
      });
      let outcome: unknown;
      let dispatchedWhileBlocked = 0;
      let overtook = false;
      try {
        controller.abort(reason);
        outcome = await withinCancellationBound(second);
        // Give an incorrectly advanced queue a turn to dispatch its third request.
        await new Promise((resolve) => setTimeout(resolve, 20));
        dispatchedWhileBlocked = dispatches;
        overtook = thirdFinished;
      } finally {
        await plain.cmd("wait-for", ["-S", channel]);
        await Promise.all([first, second, third]);
      }
      expect(outcome).toBeInstanceOf(TmuxTransportError);
      expect(outcome).toMatchObject({ kind: "cancelled", delivery: "not_started" });
      expect((outcome as TmuxTransportError).cause).toBe(reason);
      expect(dispatchedWhileBlocked).toBe(1);
      expect(overtook).toBe(false);
      expect((await first).created).toBe(false);
      expect((await third).created).toBe(false);
    });
  }, 30_000);
}

for (const kind of ["window", "pane"] as const) {
  const phases =
    kind === "pane" ? ["pending", "after-reply", "identity-reply"] : ["pending", "after-reply"];
  for (const phase of phases) {
    test(`${kind} lookup forwards cancellation during ${phase} and refuses reuse`, async () => {
      await withFixture(async (plain) => {
        const channel = `repair-${randomUUID()}`;
        const transport = new NodeSpawnTransport();
        const controller = new AbortController();
        const reason = new Error("lookup aborted");
        let enter: () => void = () => {};
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        let armed = false;
        let signal: unknown;
        let transportFailure: unknown;
        const server = intercept(plain, async (request, next) => {
          if (armed && (phase !== "identity-reply" || carries(request, "@repair_role"))) {
            armed = false;
            signal = request.signal;
            enter();
            if (phase === "pending") {
              try {
                return await transport.execute({
                  ...request,
                  commands: [["wait-for", channel], ...request.commands],
                });
              } catch (error) {
                transportFailure = error;
                throw error;
              }
            }
            const result = await next();
            controller.abort(reason);
            return result;
          }
          return next();
        });
        const session = (await server.snapshot()).sessions.one();
        const window = session.windows.one();
        await window.panes.one().setOption("@repair_role", "keep");
        armed = true;
        const pending = findExisting(kind, server, session, window, {
          signal: controller.signal,
        }).catch((error: unknown) => error);
        await entered;
        let outcome: unknown;
        try {
          if (phase === "pending") controller.abort(reason);
          outcome = await withinCancellationBound(pending);
        } finally {
          if (phase === "pending") await plain.cmd("wait-for", ["-S", channel]);
          await pending;
        }
        expect(signal).toBe(controller.signal);
        expect(outcome).toBeInstanceOf(TmuxTransportError);
        expect(outcome).toMatchObject({ kind: "cancelled" });
        if (phase === "pending") {
          expect((outcome as TmuxTransportError).cause).toBe(transportFailure);
          expect((transportFailure as TmuxTransportError).cause).toBe(reason);
        } else expect((outcome as TmuxTransportError).cause).toBe(reason);
        expect((await plain.snapshot()).sessions.count()).toBe(1);
      });
    }, 30_000);
  }
}

test("signal-aware lifecycle refresh retains a linked window's selected placement", async () => {
  await withFixture(async (server) => {
    const session = (await server.snapshot()).sessions.one();
    const shared = await session.newWindow({ name: "shared" });
    await shared.link({ session: session.id, index: 9 });
    const selected = (await server.snapshot()).windows
      .filter((window) => window.id === shared.id && window.index === 9)
      .one();
    await selected.panes.one().setOption("@repair_role", "keep");
    const result = await findOrCreatePane(selected, { option: "@repair_role", value: "keep" });
    expect(result.created).toBe(false);
    expect(Number(result.value.window?.index)).toBe(9);
    await selected.move({ index: 10 });
    await expect(
      findOrCreatePane(selected, { option: "@repair_role", value: "keep" }),
    ).rejects.toThrow("no longer at that placement");
    const current = await server.snapshot();
    expect(current.windows.filter((window) => window.id === shared.id).count()).toBe(2);
    expect(current.panes.filter((pane) => pane.id === result.value.id).count()).toBe(2);
  });
}, 30_000);

test("signal-aware lifecycle refresh refuses a replacement with the same session name", async () => {
  await withFixture(async (server) => {
    const old = await server.newSession({ name: "replace-me" });
    await old.kill();
    const replacement = await server.newSession({ name: "replace-me" });
    await expect(findOrCreateWindow(old, "unexpected")).rejects.toThrow("no longer exists");
    expect((await replacement.refreshed()).windows.count()).toBe(1);
  });
}, 30_000);
