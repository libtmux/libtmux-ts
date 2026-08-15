import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { NodeSpawnTransport } from "../../src/_internal/transport/node_spawn_transport.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";
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
  );
  return { server, transport };
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "ltx-watch-"));
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

  test("runs commands over the open connection instead of spawning", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const snapshot = await live.snapshot();

      expect(snapshot.sessions.count({ name: "watch" })).toBe(1);
      expect(snapshot.windows.count()).toBeGreaterThanOrEqual(1);
      expect(snapshot.panes.count()).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  test("mutates over the connection and sees its own change", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      const session = (await live.snapshot()).sessions.one({ name: "watch" });
      await session.newWindow({ name: "over-control" });

      expect((await live.snapshot()).windows.count({ name: "over-control" })).toBe(1);
    });
  }, 60_000);

  test("carries notifications and command responses on one connection", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      // A command round-trip proves the client has attached. Sleeping instead
      // races the attach against the mutation, and a missed notification is
      // indistinguishable from a broken stream.
      const session = (await live.snapshot()).sessions.one({ name: "watch" });

      // The stream buffers from the moment the connection opened, so iterating
      // after the round-trip does not miss what arrived during it.
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

  test("reopens a dropped connection and says so, when asked to", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const events = server.watch({ reconnect: { attempts: 3, delayMs: 25 } });

      const reconnected = until(events, (event) => event.kind === "reconnected");
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Detach the control client rather than killing the session: this is the
      // drop a long-lived process actually survives, and it leaves the fixture
      // server intact for the harness that owns it.
      await fixture.executeText(["detach-client", "-s", "watch"]).catch(() => undefined);

      const event = await reconnected;
      if (event.kind !== "reconnected") throw new Error("expected reconnected");
      expect(event.attempts).toBeGreaterThanOrEqual(1);
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

  test("gives up on a state that never arrives", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      await using live = await server.connect();

      await expect(
        live.waitFor((snapshot) => snapshot.windows.exists({ name: "never" }), { timeoutMs: 750 }),
      ).rejects.toThrow(/never arrived/u);
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

  test("cancels a command already queued on a control connection", async () => {
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
    const parent = await mkdtemp(join(tmpdir(), "ltx-absent-"));
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

  test("selects the transport by option, by environment, and by default", async () => {
    await withServer(async (fixture) => {
      const base = {
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      };

      // Whichever way the mode was chosen, the caller holds the same type and
      // makes the same calls — which is the whole point of choosing it by
      // configuration rather than by editing the code that uses it.
      const byOption = await Server.open({ ...base, transport: "control" });
      const byEnvironment = await Server.open({
        ...base,
        environment: { ...fixture.controllerEnvironment, LIBTMUX_TRANSPORT: "control" },
      });
      const spawning = await Server.open(base);
      try {
        expect((await byOption.snapshot()).sessions.count()).toBeGreaterThan(0);
        expect((await byEnvironment.snapshot()).sessions.count()).toBeGreaterThan(0);
        expect((await spawning.snapshot()).sessions.count()).toBeGreaterThan(0);
      } finally {
        // Valid on all three, and a no-op on the one holding nothing.
        await byOption.close();
        await byEnvironment.close();
        await spawning.close();
      }

      // An unreadable value is refused where it is written, rather than
      // silently spawning and leaving a caller wondering why nothing changed.
      await expect(
        Server.open({
          ...base,
          environment: { ...fixture.controllerEnvironment, LIBTMUX_TRANSPORT: "carrier-pigeon" },
        }),
      ).rejects.toThrow(TypeError);
    });
  }, 60_000);

  test("closes the connection a scope opened, even when the body throws", async () => {
    await withServer(async (fixture) => {
      const { server, transport } = countingServerFor(fixture);

      const before = transport.spawned;
      const counted = await server.withConnection(async (live) =>
        (await live.snapshot()).sessions.count(),
      );
      expect(counted).toBeGreaterThan(0);
      // The body ran over the connection, so the scope spawned nothing for it.
      expect(transport.spawned - before).toBe(0);

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

  test("runs a sequence over the connection rather than spawning for it", async () => {
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

        // Output alone cannot see this: a sequence run by spawning returns
        // exactly what one sent over the connection returns, so the only
        // evidence of which happened is whether anything was spawned. A
        // connection exists to make that number zero.
        expect(transport.spawned - before).toBe(0);
      } finally {
        await live.close();
      }
    });
  }, 60_000);

  test("runs a sequence over a connection without disturbing correlation", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const live = await server.connect();
      try {
        // tmux answers a chained line with one block per command, and this
        // connection pairs one block with one request — so a chain sent down it
        // would hand each reply to the request behind it. Sending them
        // separately keeps the pairing and costs the same on an open socket.
        const results = await live.pipeline([
          ["display-message", "-p", "FIRST"],
          ["display-message", "-p", "SECOND"],
          ["display-message", "-p", "THIRD"],
        ]);

        expect(results).toEqual([["FIRST"], ["SECOND"], ["THIRD"]]);

        // And the connection still pairs correctly afterwards.
        expect(await live.cmd("display-message", ["-p", "AFTER"], { target: null })).toEqual([
          "AFTER",
        ]);
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

        // Same semantics as the chained form: earlier applied, later never ran.
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
        // One transport chains the commands and frames the output with a
        // marker; the other sends them one at a time and gets tmux's own
        // framing. A caller must not be able to tell which ran.
        const commands = [
          ["display-message", "-p", "plain"],
          ["display-message", "-p", ""], // prints one blank line
          ["set-option", "-g", "status", "off"], // prints nothing
          ["display-message", "-p", "a b;c 'd' \"e\""],
          ["display-message", "-p", "日本語🚀"],
        ];

        const chained = await server.pipeline(commands);
        const sent = await live.pipeline(commands);

        expect(chained).toEqual(sent);
        // A command that printed one blank line reads as having printed
        // nothing, which is what `cmd` answers for the same command.
        expect(chained[1]).toEqual([]);
        expect(chained[2]).toEqual([]);
        expect(chained[3]).toEqual(["a b;c 'd' \"e\""]);
        expect(chained[4]).toEqual(["日本語🚀"]);
      } finally {
        await live.close();
      }
    });
  }, 60_000);
});
