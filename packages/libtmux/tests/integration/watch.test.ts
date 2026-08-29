import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import {
  createRuntimeContext,
  createServerWithRuntime,
} from "../../src/_internal/runtime/context.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  TEST_HANDLE_PROTOTYPES,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";
import { LibTmuxException, WaitTimeout } from "../../src/exc.js";
import { Server } from "../../src/server.js";
import type { TmuxEvent, TmuxEventStream } from "../../src/types.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

/** Counts what it is asked to spawn, so a caller can assert nothing was. */
class CountingSpawnTransport implements CommandTransport {
  spawned = 0;
  readonly #inner = new NodeSpawnTransport();

  execute(request: CommandRequest): Promise<RawCommandResult> {
    this.spawned += 1;
    return this.#inner.execute(request);
  }
}

/** A server whose spawning is observable, which `new Server()` does not expose. */
function countingServerFor(fixture: TestServer): {
  server: Server;
  transport: CountingSpawnTransport;
} {
  const transport = new CountingSpawnTransport();
  const server = createServerWithRuntime(
    createRuntimeContext({
      connection: new TmuxConnection({
        environment: fixture.controllerEnvironment,
        executable: fixture.tmuxExecutable,
        socketPath: fixture.socketPath,
      }),
      connectionAlias: randomUUID() as ConnectionAlias,
      daemonEpoch: 0 as DaemonEpoch,
      transport,
    }),
    TEST_HANDLE_PROTOTYPES,
  );
  return { server, transport };
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-watch-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "watch" });
        await runWithCleanup(
          () => body(fixture),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

/** Fail loudly rather than returning undefined, which reads better in a test. */
async function until(
  events: TmuxEventStream,
  want: (event: TmuxEvent) => boolean,
  boundMs = 15_000,
): Promise<TmuxEvent> {
  const event = await events.find(want, { timeoutMs: boundMs });
  if (event === undefined) throw new Error("the watched event never arrived");
  return event;
}

/** The names tmux currently lists for attached clients. */
async function clientNames(server: Server): Promise<readonly string[]> {
  const listed = await server
    .cmd("list-clients", ["-F", "#{client_name}"], { target: null })
    .catch(() => []);
  return listed.filter((name) => name !== "");
}

/**
 * End only the clients this connection added.
 *
 * `detach-client -s <session>` would take down every client attached to the
 * session, including the fixture's own trusted controller — which the harness
 * needs to clean up after itself, and whose loss surfaces later as foreign
 * evidence on the fixture socket rather than as anything to do with this test.
 */
async function detachOwn(server: Server, before: ReadonlySet<string>): Promise<void> {
  for (const name of await clientNames(server)) {
    if (before.has(name)) continue;
    // eslint-disable-next-line no-await-in-loop -- a handful of clients at most.
    await server.cmd("detach-client", ["-t", name], { target: null }).catch(() => undefined);
  }
}

/** Poll until `ready` holds, so a busy machine cannot decide the result. */
async function waitUntil(
  ready: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Server.watch", () => {
  test("reports a window opening on the server it is attached to", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();

      const arrived = until(events, (event) => event.kind === "window-add");
      // The stream has to be listening before the change, which is the whole
      // difference between watching and polling.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await fixture.executeText(["new-window", "-d", "-t", "watch:"]);

      expect((await arrived).kind).toBe("window-add");
    });
  }, 60_000);

  test("reports a window being renamed, with the new name", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();

      const arrived = until(events, (event) => event.kind === "window-renamed");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await fixture.executeText(["rename-window", "-t", "watch:", "renamed-by-test"]);

      const event = await arrived;
      if (event.kind !== "window-renamed") throw new Error("expected window-renamed");
      expect(event.name).toBe("renamed-by-test");
      expect(event.windowId.startsWith("@")).toBe(true);
    });
  }, 60_000);

  test("streams pane output, which a control client only sees once attached", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();

      const arrived = until(
        events,
        (event) => event.kind === "output" && event.data.includes("libtmux-watched"),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      await fixture.executeText([
        "new-window",
        "-d",
        "-t",
        "watch:",
        "printf 'libtmux-watched\\n'; sleep 5",
      ]);

      const event = await arrived;
      if (event.kind !== "output") throw new Error("expected output");
      expect(event.paneId.startsWith("%")).toBe(true);
      // tmux escapes control bytes as octal; the newline has to survive as one.
      expect(event.data).toContain("libtmux-watched");
    });
  }, 60_000);

  test("decodes multi-byte output without splitting a character", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();

      const arrived = until(events, (event) => event.kind === "output" && event.data.includes("→"));
      await new Promise((resolve) => setTimeout(resolve, 250));
      await fixture.executeText([
        "new-window",
        "-d",
        "-t",
        "watch:",
        "printf 'a\\xe2\\x86\\x92b\\n'; sleep 5",
      ]);

      const event = await arrived;
      if (event.kind !== "output") throw new Error("expected output");
      expect(event.data).toContain("a→b");
    });
  }, 60_000);

  test("ends the stream and the tmux process when disposed", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();
      const drained = (async () => {
        let seen = 0;
        for await (const _event of events) seen += 1;
        return seen;
      })();

      await new Promise((resolve) => setTimeout(resolve, 250));
      await events.close();

      // The loop terminating is the assertion: disposal ends iteration rather
      // than leaving the consumer awaiting an event that will never arrive.
      expect(await drained).toBeGreaterThanOrEqual(0);
      expect(events.dropped).toBe(0);
    });
  }, 60_000);

  /**
   * tmux evaluates a subscription on a one-second timer, so a report is a
   * change rather than every value, and the deadline has to outlast a tick.
   */
  test("reports a subscribed format at each scope", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch({
        subscriptions: [
          { format: "#{session_name}", name: "session" },
          { format: "#{pane_current_command}", name: "cmd", scope: "all-panes" },
        ],
      });
      try {
        const seen = new Map<string, string>();
        for await (const event of events) {
          if (event.kind !== "subscription-changed") continue;
          seen.set(event.name, event.value);
          if (event.name === "cmd") {
            // A pane-scope report names the object it expanded against; a
            // session-scope one has no window or pane to name.
            expect(event.paneId).toMatch(/^%\d+$/u);
            expect(event.windowId).toMatch(/^@\d+$/u);
          }
          if (event.name === "session") expect(event.paneId).toBeUndefined();
          if (seen.size === 2) break;
        }
        expect(seen.get("session")).toBe("watch");
        expect(seen.get("cmd")).not.toBe("");
      } finally {
        await events.close();
      }
    });
  }, 60_000);

  test("subscribes and unsubscribes on a live connection", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();
      const events = live.subscribe();
      await live.subscribeFormat({ format: "#{session_name}", name: "who" });

      const first = await events.find(
        (event) => event.kind === "subscription-changed" && event.name === "who",
        { timeoutMs: 20_000 },
      );
      expect(first).toMatchObject({ kind: "subscription-changed", value: "watch" });

      // Unsubscribing is the same command with the name alone; tmux answers
      // nothing, so the assertion is that it was accepted.
      await live.unsubscribeFormat("who");
      await events.close();
    });
  }, 60_000);

  test("refuses a subscription name tmux would misread", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();
      // A colon splits the subscribe grammar and a space makes the report's
      // fields ambiguous; both are refused here rather than sent.
      await expect(
        live.subscribeFormat({ format: "#{session_name}", name: "a:b" }),
      ).rejects.toThrow(/subscription name/u);
      await expect(
        live.subscribeFormat({ format: "#{session_name}", name: "a b" }),
      ).rejects.toThrow(/subscription name/u);
      await expect(live.subscribeFormat({ format: "a\nb", name: "ok" })).rejects.toThrow(
        /line break/u,
      );
    });
  }, 60_000);

  test("refuses a second iteration of the same stream", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();
      try {
        for await (const _event of events) break;

        await expect(
          (async () => {
            for await (const _event of events) break;
          })(),
        ).rejects.toThrow(/iterated once/u);
      } finally {
        await events.close();
      }
    });
  }, 60_000);

  test("ends the connection through the async disposal protocol", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();
      const drained = (async () => {
        for await (const _event of events) void _event;
      })();

      // `await using` compiles to exactly this call; tests/types/watch.test.ts
      // pins that the syntax itself type-checks for a consumer.
      await events[Symbol.asyncDispose]();

      await drained;
      expect(events.dropped).toBe(0);
    });
  }, 60_000);

  test("snapshots through a connected server", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const snapshot = await live.snapshot();

      expect(snapshot.sessions.count({ name: "watch" })).toBe(1);
      expect(snapshot.windows.count()).toBeGreaterThanOrEqual(1);
      expect(snapshot.panes.count()).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  test("mutates through a connected server and sees its own change", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const session = (await live.snapshot()).sessions.one({ name: "watch" });
      await session.newWindow({ name: "over-control" });

      expect((await live.snapshot()).windows.count({ name: "over-control" })).toBe(1);
    });
  }, 60_000);

  test("observes a change made through the connected server", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const session = (await live.snapshot()).sessions.one({ name: "watch" });

      const arrived = until(live.subscribe(), (event) => event.kind === "window-add");
      await session.newWindow({ name: "both-ways" });

      expect((await arrived).kind).toBe("window-add");
      expect((await live.snapshot()).windows.count({ name: "both-ways" })).toBe(1);
    });
  }, 60_000);

  test("reports a closed connection rather than hanging", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      await live.close();

      await expect(live.snapshot()).rejects.toThrow(/closed/u);
    });
  }, 60_000);

  test("gates readiness on the replacement after a dropped connection", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one({ name: "watch" });
      const before = new Set(await clientNames(server));
      const events = server.watch({ reconnect: { attempts: 3, delayMs: 25 } });
      const reconnecting = Promise.withResolvers<void>();
      let reconnectedAttempts: number | undefined;
      let sawWindowAdd = false;
      const drain = (async () => {
        for await (const event of events) {
          if (event.kind === "reconnecting") reconnecting.resolve();
          if (event.kind === "reconnected") reconnectedAttempts = event.attempts;
          if (event.kind === "window-add") sawWindowAdd = true;
        }
      })();
      try {
        await events.ready();
        await detachOwn(server, before);
        await reconnecting.promise;

        // A change made after the retired generation reports ready is lost.
        // The replacement generation must attach before this barrier answers.
        const replacementReady = events.ready();
        let readySettled = false;
        void replacementReady.then(
          () => {
            readySettled = true;
          },
          () => undefined,
        );
        await Promise.resolve();
        expect(readySettled).toBe(false);
        await replacementReady;
        await session.newWindow({ name: "after-reconnect-ready" });

        await waitUntil(() => sawWindowAdd, "the replacement client to announce the window", 5_000);
        expect(reconnectedAttempts).toBeGreaterThanOrEqual(1);
      } finally {
        await events.close();
        await drain.catch(() => undefined);
      }
    });
  }, 60_000);

  test("does not reopen by default, so a server going away is visible", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch();
      const kinds: string[] = [];
      const drained = (async () => {
        for await (const event of events) kinds.push(event.kind);
      })();

      await new Promise((resolve) => setTimeout(resolve, 250));
      await events.close();
      await drained;

      // The stream ends rather than silently reattaching, which is what makes a
      // server going away visible to the caller.
      expect(kinds).not.toContain("reconnected");
    });
  }, 60_000);

  test("waits for a state that only becomes true later", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const session = (await live.snapshot()).sessions.one({ name: "watch" });
      const arriving = live.waitFor((snapshot) => snapshot.windows.exists({ name: "awaited" }), {
        timeoutMs: 20_000,
      });
      await session.newWindow({ name: "awaited" });

      expect((await arriving).windows.count({ name: "awaited" })).toBe(1);
    });
  }, 60_000);

  test("polls for whole-server state with no notification", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const remote = await server.newSession({ name: "quiet", shellCommand: "sleep 60" });
      const pane = remote.panes.one();
      await using live = await server.connect({ target: "watch" });
      let arm!: () => void;
      const armed = new Promise<void>((resolve) => {
        arm = resolve;
      });

      const arriving = live.waitFor(
        (snapshot) => {
          arm();
          return snapshot.panes.exists({ id: pane.id, title: "arrived" });
        },
        { pollIntervalMs: 50, timeoutMs: 1_500 },
      );
      await armed;
      await fixture.executeText(["select-pane", "-t", pane.id, "-T", "arrived"]);

      expect((await arriving).panes.one({ id: pane.id }).title).toBe("arrived");
    });
  }, 60_000);

  test("returns at once when the state is already true", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // No event will arrive for a condition that already holds, so a wait that
      // only listens would hang here.
      const snapshot = await live.waitFor((server_) => server_.sessions.exists({ name: "watch" }));

      expect(snapshot.sessions.count({ name: "watch" })).toBe(1);
    });
  }, 60_000);

  /**
   * Closing the connection, rather than the stream on top of it.
   *
   * A stream fixture cannot reach this: the connection fans its ending out to
   * every subscriber, and telling a deliberate close from a dropped connection
   * is a distinction only the connection can make. `withConnection` and
   * `await using` on a connected server both end this way, so "connect, race a
   * wait, close on the way out" is the ordinary shape, not an exotic one.
   */
  test("answers a waiting find when the connection is closed on purpose", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      const events = live.subscribe();
      await events.ready();

      const armed = events.find(() => false, { timeoutMs: 60_000 });
      await live.close();

      // Raising here would reject a promise the caller has already stopped
      // holding — an unhandled rejection rather than a diagnosis.
      expect(await armed).toBeUndefined();
    });
  }, 60_000);

  test("raises a waiting find when the server goes away under it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      const events = live.subscribe();
      await events.ready();

      // Armed before anything is awaited: the connection dies during the kill,
      // and a rejection with no handler yet attached is the hazard this
      // behaviour exists to keep out of a caller's code.
      const armed = events
        .find(() => false, { timeoutMs: 30_000 })
        .then(
          () => "resolved",
          (error: unknown) => (error as Error).message,
        );
      await server.cmd("kill-server").catch(() => undefined);

      // The other half of the same decision: this one says nothing about the
      // condition, so answering undefined would blame the workload.
      expect(await armed).toMatch(/ended before a match/u);
      await live.close().catch(() => undefined);
    });
  }, 60_000);

  test("gives up on a state that never arrives, saying it was the deadline", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // A deadline says the condition did not come true; a connection ending
      // says nothing about the condition at all. One error for both leaves a
      // caller unable to tell which happened.
      const failure = await live
        .waitFor((snapshot) => snapshot.windows.exists({ name: "never" }), { timeoutMs: 750 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(WaitTimeout);
      expect(failure).toBeInstanceOf(LibTmuxException);
    });
  }, 60_000);

  test("serves a wait and a loop from one connection at the same time", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const session = (await live.snapshot()).sessions.one({ name: "watch" });
      // Both subscriptions must see the change: a shared stream would let one
      // consume what the other was waiting for.
      const looping = until(live.subscribe(), (event) => event.kind === "window-add");
      const waiting = live.waitFor((snapshot) => snapshot.windows.exists({ name: "shared" }), {
        timeoutMs: 20_000,
      });
      await session.newWindow({ name: "shared" });

      expect((await looping).kind).toBe("window-add");
      expect((await waiting).windows.count({ name: "shared" })).toBe(1);
    });
  }, 60_000);

  test("reads a response line that looks like a notification", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // split-window -P answers with a pane id, and a pane id is `%1`. Routing
      // by the first character reads that as a notification and the command
      // comes back empty; only its position inside the block identifies it.
      const window = (await live.snapshot()).windows.one();
      const pane = await window.split();

      expect(pane.id.startsWith("%")).toBe(true);
      expect((await live.snapshot()).panes.count({ window: { is: { id: window.id } } })).toBe(2);
    });
  }, 60_000);

  test("bounds a command by the server's default deadline", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        timeoutMs: 1,
        tmuxBin: fixture.tmuxExecutable,
      });

      // One millisecond is shorter than any real tmux round trip, so the
      // deadline is what ends this rather than tmux answering.
      await expect(server.snapshot()).rejects.toThrow();
    });
  }, 60_000);

  test("abandons a command when its signal fires", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();
      const controller = new AbortController();

      const capture = pane.capture({ signal: controller.signal });
      controller.abort();

      await expect(capture).rejects.toThrow();
    });
  }, 60_000);

  test("rejects an already-aborted connected command", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();
      const pane = (await live.snapshot()).panes.one();
      const controller = new AbortController();
      controller.abort();

      await expect(pane.capture({ signal: controller.signal })).rejects.toThrow(/cancel/u);
    });
  }, 60_000);

  test("says why it could not attach, at the point of connecting", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);

      // tmux explains a refused attach in its own words. Reporting them here
      // beats surfacing them through whichever command happens to run first.
      await expect(server.connect({ target: "$99999" })).rejects.toThrow(
        /could not attach.*(?:find session|no sessions)/u,
      );
    });
  }, 60_000);

  test("rejects a buffer size that cannot hold an event", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      expect(() => server.watch({ bufferSize: 0 })).toThrow(/positive integer/u);
      expect(() => server.watch({ bufferSize: 1.5 })).toThrow(/positive integer/u);
    });
  }, 60_000);

  test("keeps later commands aligned when one is cancelled mid-flight", async () => {
    await withServer(async (fixture) => {
      const live = await serverFor(fixture).connect();
      try {
        // tmux answers commands in the order it received them, so the queue's
        // order is what correlates a response to its request. A cancelled
        // command is still owed a block, and dropping it from the queue would
        // hand that block to the next command in line — leaving every later
        // command answering with its predecessor's output.
        const controller = new AbortController();
        const cancelled = live.cmd("display-message", ["-p", "CANCELLED"], {
          signal: controller.signal,
          target: null,
        });
        const markers = ["SECOND", "THIRD", "FOURTH"];
        const queued = markers.map((marker) =>
          live.cmd("display-message", ["-p", marker], { target: null, timeoutMs: 20_000 }),
        );
        controller.abort();

        await expect(cancelled).rejects.toThrow(/cancelled/u);
        expect(await Promise.all(queued)).toEqual(markers.map((marker) => [marker]));
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("keeps later commands aligned when one times out", async () => {
    await withServer(async (fixture) => {
      const live = await serverFor(fixture).connect();
      try {
        // The same hazard reached through the deadline rather than a signal.
        const expired = live.cmd("display-message", ["-p", "EXPIRED"], {
          target: null,
          timeoutMs: 1,
        });
        const queued = live.cmd("display-message", ["-p", "AFTER"], {
          target: null,
          timeoutMs: 20_000,
        });

        // Whether the deadline beats tmux is a race; either outcome is fine,
        // and the command behind it must be answered correctly regardless.
        await expired.catch(() => undefined);

        expect(await queued).toEqual(["AFTER"]);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("drops each command's abort subscription once it is answered", async () => {
    await withServer(async (fixture) => {
      const live = await serverFor(fixture).connect();
      try {
        // One controller for a whole run is the shape a long-lived consumer
        // has. Without the release, every command leaves a listener behind
        // holding its buffer, and the set only grows.
        const controller = new AbortController();
        const signal = controller.signal as unknown as {
          addEventListener: (...args: unknown[]) => void;
          removeEventListener: (...args: unknown[]) => void;
        };
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        let added = 0;
        let removed = 0;
        signal.addEventListener = (...args: unknown[]): void => {
          added += 1;
          add(...args);
        };
        signal.removeEventListener = (...args: unknown[]): void => {
          removed += 1;
          remove(...args);
        };

        for (let run = 0; run < 8; run += 1) {
          // eslint-disable-next-line no-await-in-loop -- each command settles before the next.
          await live.cmd("display-message", ["-p", `run-${String(run)}`], {
            signal: controller.signal,
            target: null,
          });
        }

        expect(added).toBe(8);
        expect(removed).toBe(added);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("keeps multi-byte output whole across notification boundaries", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      const events = live.subscribe();
      try {
        const session = (await server.snapshot()).sessions.one();
        // tmux emits %output for whatever it read from the pty, so a dense run
        // of four-byte characters with no line breaks lands a read boundary
        // inside a character. Decoding each notification alone replaces the
        // halves with U+FFFD.
        await session.newWindow({
          shellCommand: `sh -c 'printf "\u{1F680}%.0s" $(seq 1 4000); printf "\\nMARKER\\n"; sleep 30'`,
        });

        let text = "";
        const deadline = Date.now() + 20_000;
        for await (const event of events) {
          if (event.kind === "output") text += event.data;
          if (text.includes("MARKER") || Date.now() > deadline) break;
        }

        expect(text).toContain("MARKER");
        expect(text).not.toContain("\uFFFD");
        expect(text.split("\u{1F680}").length - 1).toBe(4000);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("does not withhold output a pane never completes", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      const events = live.subscribe();
      try {
        const session = (await server.snapshot()).sessions.one();
        // A lone 0xff begins no character. Waiting for a continuation that
        // cannot arrive would hold this pane's output back indefinitely.
        await session.newWindow({
          shellCommand: `sh -c 'printf "\\377"; printf "AFTER-BINARY\\n"; sleep 30'`,
        });

        let text = "";
        const deadline = Date.now() + 20_000;
        for await (const event of events) {
          if (event.kind === "output") text += event.data;
          if (text.includes("AFTER-BINARY") || Date.now() > deadline) break;
        }

        expect(text).toContain("AFTER-BINARY");
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("gives each outage its own reconnect budget", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const before = new Set(await clientNames(server));
      const events = server.watch({ reconnect: { attempts: 1, delayMs: 30 } });
      let reconnects = 0;
      const drain = (async () => {
        for await (const event of events) if (event.kind === "reconnected") reconnects += 1;
      })();
      try {
        // A budget that is never restored reads as "reconnect once ever", so a
        // long-lived watcher stops recovering after N drops across its whole
        // life and reports nothing when it does.
        for (let outage = 1; outage <= 3; outage += 1) {
          // Detaching can land while the client is still attaching, in which
          // case it detaches nothing and there is no outage to recover from.
          // Driving it until the reconnect is observed tests the budget rather
          // than the timing of one command.
          // eslint-disable-next-line no-await-in-loop -- one outage at a time, by design.
          await waitUntil(
            async () => {
              if (reconnects >= outage) return true;
              await detachOwn(server, before);
              await new Promise((resolve) => setTimeout(resolve, 150));
              return reconnects >= outage;
            },
            `reconnect ${String(outage)}`,
          );
          expect(reconnects).toBe(outage);
        }
      } finally {
        await events.close();
        await drain.catch(() => undefined);
      }
    });
  }, 60_000);

  test("says so promptly instead of hanging while it reconnects", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const before = new Set(await clientNames(server));
      const live = await server.connect({ reconnect: { attempts: 5, delayMs: 300 } });
      try {
        await detachOwn(server, before);

        // The old pipe accepts bytes and answers nothing, so without the
        // refusal a command waits out its deadline — or never returns, since a
        // deadline is optional. Retrying until the connection has noticed the
        // drop tests that refusal rather than how fast the machine delivers a
        // close event.
        let refusedIn: number | undefined;
        const deadline = Date.now() + 20_000;
        while (refusedIn === undefined && Date.now() < deadline) {
          const started = Date.now();
          // eslint-disable-next-line no-await-in-loop -- one attempt at a time, by design.
          const outcome = await live
            .cmd("display-message", ["-p", "DURING"], { target: null, timeoutMs: 10_000 })
            .then(
              () => undefined,
              (error: Error) => error,
            );
          if (outcome?.message.includes("reconnecting") === true) refusedIn = Date.now() - started;
        }

        expect(refusedIn).toBeDefined();
        expect(refusedIn!).toBeLessThan(1_000);

        // And the connection comes back, rather than staying refused.
        await waitUntil(
          () =>
            live.cmd("display-message", ["-p", "AFTER"], { target: null, timeoutMs: 10_000 }).then(
              (lines) => lines[0] === "AFTER",
              () => false,
            ),
          "the connection to reopen",
        );
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("announces a change made after readiness resolves", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      await using events = server.watch({ target: session.id });

      // A control client hears nothing that happened before it attached, so a
      // change made between opening the stream and the attach is lost. Without
      // a way to await the attach, every watch-then-act caller races it.
      await events.ready();
      const opened = session.newWindow({ name: "after-ready" });

      const event = await events.find((candidate) => candidate.kind === "window-add", {
        timeoutMs: 20_000,
      });
      await opened;

      expect(event?.kind).toBe("window-add");
    });
  }, 60_000);

  test("answers readiness asked after the attach already settled", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      await using events = server.watch({ target: session.id });

      // Nobody asks about readiness until well after tmux has answered the
      // attach: a snapshot is several commands and several processes, which is
      // far longer than the acknowledgement takes to come back. A latch that
      // only signals has nothing left to signal by then, and answers the
      // question by never answering it — so this asks late on purpose.
      await server.snapshot();

      const answered = await Promise.race([
        events.ready().then(() => "answered"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("waited for something that already happened"), 5_000);
        }),
      ]);

      expect(answered).toBe("answered");
    });
  }, 60_000);

  test("forgets a subscriber once its stream closes", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      try {
        // Every notification is pushed to every registered subscriber and
        // buffered there, and `waitFor` subscribes internally — so a
        // subscriber left registered after closing keeps filling for the life
        // of the connection, one buffer per wait.
        for (let run = 0; run < 6; run += 1) {
          // eslint-disable-next-line no-await-in-loop -- each wait settles before the next.
          await live.waitFor(() => true);
        }
        const stream = live.subscribe();
        await stream.close();

        // The connection still works, and nothing accumulated behind it.
        expect(await live.cmd("display-message", ["-p", "ALIVE"], { target: null })).toEqual([
          "ALIVE",
        ]);
        expect(stream.dropped).toBe(0);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("never brings a server into being just by watching", async () => {
    const parent = await makeTestDirectory("ltx-absent-");
    const socketPath = join(parent, "absent.sock");
    try {
      // `tmux -C attach-session` on a socket with no server creates the socket
      // and starts a server behind it before reporting "no sessions". Watching
      // observes a server; it must not conjure one, and the stray socket it
      // would leave behind belongs to nobody.
      const server = new Server({ socketPath });

      await expect(server.connect()).rejects.toThrow();

      expect(
        await stat(socketPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }, 30_000);

  test("closes the connection a scope opened, even when the body throws", async () => {
    await withServer(async (fixture) => {
      const { server, transport } = countingServerFor(fixture);

      const before = transport.spawned;
      const counted = await server.withConnection(async (live) =>
        (await live.snapshot()).sessions.count(),
      );
      expect(counted).toBeGreaterThan(0);
      // One observer authentication, one version probe, and one acquisition.
      expect(transport.spawned - before).toBe(3);

      let captured: unknown;
      await server
        .withConnection(async () => {
          throw new Error("body failed");
        })
        .catch((error: unknown) => {
          captured = error;
        });
      expect((captured as Error).message).toBe("body failed");

      // A scope that leaked its connection would leave this client attached.
      await waitUntil(
        async () => (await clientNames(server)).length <= 1,
        "the scope's connection to close",
      );
    });
  }, 60_000);

  test("keeps connected commands on process boundaries", async () => {
    await withServer(async (fixture) => {
      const { server, transport } = countingServerFor(fixture);
      const live = await server.connect();
      try {
        const before = transport.spawned;

        await live.pipeline([
          ["display-message", "-p", "one"],
          ["display-message", "-p", "two"],
          ["display-message", "-p", "three"],
        ]);

        // Authentication is shared; each user command keeps its own process.
        expect(transport.spawned - before).toBe(4);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("stops a connected sequence at its first failure", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      try {
        await expect(
          live.pipeline([
            ["new-window", "-d", "-n", "kept"],
            ["kill-window", "-t", "no-such-window-9999"],
            ["new-window", "-d", "-n", "unreached"],
          ]),
        ).rejects.toThrow();

        const windows = (await server.snapshot()).windows;
        expect(windows.exists({ name: "kept" })).toBe(true);
        expect(windows.exists({ name: "unreached" })).toBe(false);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("answers a sequence the same way over either transport", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      try {
        const commands = [
          ["display-message", "-p", "plain"],
          ["display-message", "-p", ""], // prints one blank line
          ["set-option", "-g", "status", "off"], // prints nothing
          ["display-message", "-p", "a b;c 'd' \"e\""],
          ["display-message", "-p", "日本語🚀"],
        ];

        const spawned = await server.pipeline(commands);
        const connected = await live.pipeline(commands);

        expect(spawned).toEqual(connected);
        expect(spawned[1]).toEqual([""]);
        expect(spawned[2]).toEqual([]);
        expect(spawned[3]).toEqual(["a b;c 'd' \"e\""]);
        expect(spawned[4]).toEqual(["日本語🚀"]);
      } finally {
        await live.close();
      }
    });
  }, 60_000);
  test("closing on purpose leaves an abandoned wait handled", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const unhandled: unknown[] = [];
      const record = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", record);
      try {
        const live = await server.connect();
        // Abandoned on purpose: a race whose other side won, or a scope that
        // ended. Nobody holds this promise any more, so the rejection the close
        // causes is one the caller has no way left to catch.
        void live.waitFor((snapshot) => snapshot.windows.exists({ name: "never" }), {
          timeoutMs: 30_000,
        });
        await live.close();
        await new Promise((resolve) => setTimeout(resolve, 250));

        const ours = unhandled.filter(
          (reason) => reason instanceof LibTmuxException || reason instanceof WaitTimeout,
        );
        expect(ours).toEqual([]);
      } finally {
        // Bun hides the inherited generic overload, so detach through the EventEmitter view.
        const processEvents: Pick<EventEmitter, "off"> = process;
        processEvents.off("unhandledRejection", record);
      }
    });
  }, 40_000);

  test("a wait somebody is holding still learns the connection closed under it", async () => {
    await withServer(async (fixture) => {
      const live = await serverFor(fixture).connect();
      // Guarding the abandoned case must not swallow this one: attaching a
      // handler marks a promise handled, it does not consume the rejection.
      const armed = live.waitFor((snapshot) => snapshot.windows.exists({ name: "never" }), {
        timeoutMs: 30_000,
      });
      await live.close();
      await expect(armed).rejects.toThrow(LibTmuxException);
    });
  }, 40_000);
});
