import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, test } from "bun:test";

import type { ServerSnapshot, Session, TmuxEvent, Window } from "libtmux";

import type { ToolContext } from "../src/context.js";
import type { LiveListener } from "../src/live.js";
import type { PaneTailEndReason } from "../src/pane_tail.js";
import { resolvePolicy } from "../src/policy.js";
import { registerResourceCatalog } from "../src/resource_catalog.js";
import { type TopologyLease, watchTopology } from "../src/resource_topology.js";
import { registerResourceSubscriptions } from "../src/resource_watch.js";

function snapshot(...sessionIds: readonly string[]): ServerSnapshot {
  const empty = { toArray: () => [] };
  return {
    clients: empty,
    panes: empty,
    sessions: {
      toArray: () => sessionIds.map((id) => ({ id, name: id }) as Session),
    },
    windows: {
      toArray: () =>
        sessionIds.map(
          (sessionId, index) =>
            ({
              format: { session_id: sessionId },
              id: `@${String(index + 1)}`,
            }) as Window,
        ),
    },
  } as unknown as ServerSnapshot;
}

function linkedSnapshot(extraWindow = false): ServerSnapshot {
  return {
    ...snapshot("$1", "$2"),
    windows: {
      toArray: () => [
        { format: { session_id: "$1" }, id: "@1" } as Window,
        { format: { session_id: "$2" }, id: "@1" } as Window,
        ...(extraWindow ? [{ format: { session_id: "$2" }, id: "@2" } as Window] : []),
      ],
    },
  } as unknown as ServerSnapshot;
}

function overlappingSnapshot(): ServerSnapshot {
  return {
    ...snapshot("$1", "$2", "$3"),
    windows: {
      toArray: () => [
        { format: { session_id: "$1" }, id: "@1" } as Window,
        { format: { session_id: "$1" }, id: "@2" } as Window,
        { format: { session_id: "$2" }, id: "@1" } as Window,
        { format: { session_id: "$2" }, id: "@3" } as Window,
        { format: { session_id: "$3" }, id: "@2" } as Window,
        { format: { session_id: "$3" }, id: "@4" } as Window,
      ],
    },
  } as unknown as ServerSnapshot;
}

function snapshotWithPane(paneId: string, windowId = "@1"): ServerSnapshot {
  return {
    ...snapshot("$1"),
    panes: {
      toArray: () => [
        {
          format: { session_id: "$1", window_id: windowId, window_index: "0" },
          id: paneId,
        },
      ],
    },
  } as unknown as ServerSnapshot;
}

function catalogLease(): TopologyLease {
  return { release: () => undefined, retain: () => undefined };
}

function contextWith(
  listen: (
    sessionId: string,
    listener: (event: TmuxEvent) => void,
    signal?: AbortSignal,
  ) => Promise<LiveListener | undefined>,
  takeSnapshot: (signal?: AbortSignal) => Promise<ServerSnapshot> = async () => snapshot("$1"),
): ToolContext {
  return {
    hub: { closed: false, listen },
    policy: resolvePolicy({}),
    snapshot: takeSnapshot,
  } as unknown as ToolContext;
}

function controlledListener(): {
  end(reason?: PaneTailEndReason): void;
  readonly listener: LiveListener;
  stops(): number;
} {
  const ended = Promise.withResolvers<PaneTailEndReason>();
  let active = true;
  let stops = 0;
  const listener = (() => {
    if (!active) return;
    active = false;
    stops += 1;
  }) as LiveListener;
  Object.defineProperties(listener, {
    active: { get: () => active },
    ended: { value: ended.promise },
  });
  return {
    end: (reason = "connection_lost") => {
      active = false;
      ended.resolve(reason);
    },
    listener,
    stops: () => stops,
  };
}

async function waitUntil(predicate: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop -- bounded polling follows retry state.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failure);
}

test("takes no catalog snapshot before the first watch attempt settles", async () => {
  const waiting = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let snapshots = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  mcp.server.registerCapabilities({ resources: {} });
  registerResourceCatalog(
    mcp,
    {
      snapshot: async () => {
        snapshots += 1;
        return snapshot();
      },
    } as unknown as ToolContext,
    async () => {
      entered.resolve();
      await waiting.promise;
      return catalogLease();
    },
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const listing = client.listResources();
  try {
    await entered.promise;
    expect(snapshots).toBe(0);

    waiting.resolve();
    await listing;
    expect(snapshots).toBe(1);
  } finally {
    waiting.resolve();
    await Promise.allSettled([listing]);
    await client.close();
  }
});

test("does not snapshot a catalog after its request is cancelled", async () => {
  const waiting = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let snapshots = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  mcp.server.registerCapabilities({ resources: {} });
  registerResourceCatalog(
    mcp,
    {
      snapshot: async () => {
        snapshots += 1;
        return snapshot();
      },
    } as unknown as ToolContext,
    async (requestSignal?: AbortSignal) => {
      signal = requestSignal;
      entered.resolve();
      await waiting.promise;
      return { release: released.resolve, retain: () => undefined };
    },
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const controller = new AbortController();
  const listing = client.listResources(undefined, { signal: controller.signal });
  try {
    await entered.promise;
    controller.abort();
    await listing.catch(() => undefined);
    waiting.resolve();
    await released.promise;

    expect(signal?.aborted).toBe(true);
    expect(snapshots).toBe(0);
  } finally {
    waiting.resolve();
    await Promise.allSettled([listing]);
    await client.close();
  }
});

test("passes cancellation into and joins the catalog snapshot", async () => {
  const entered = Promise.withResolvers<void>();
  const releaseObserved = Promise.withResolvers<void>();
  const snapshotting = Promise.withResolvers<ServerSnapshot>();
  let released = 0;
  let retained = 0;
  let snapshotSignal: AbortSignal | undefined;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  mcp.server.registerCapabilities({ resources: {} });
  registerResourceCatalog(
    mcp,
    {
      snapshot: (signal?: AbortSignal) => {
        snapshotSignal = signal;
        entered.resolve();
        return snapshotting.promise;
      },
    } as unknown as ToolContext,
    async () => ({
      release: () => {
        released += 1;
        releaseObserved.resolve();
      },
      retain: () => {
        retained += 1;
      },
    }),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const controller = new AbortController();
  const listing = client.listResources(undefined, { signal: controller.signal });
  try {
    await entered.promise;
    controller.abort();
    await listing.catch(() => undefined);

    expect(snapshotSignal?.aborted).toBe(true);
    expect(retained).toBe(0);
    expect(released).toBe(0);

    snapshotting.resolve(snapshot("$1"));
    await releaseObserved.promise;
    expect(released).toBe(1);
  } finally {
    snapshotting.resolve(snapshot("$1"));
    await releaseObserved.promise;
    await Promise.allSettled([listing]);
    await client.close();
  }
});

test("does not retain a topology lease for an invalid catalog cursor", async () => {
  let released = 0;
  let retained = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  mcp.server.registerCapabilities({ resources: {} });
  registerResourceCatalog(
    mcp,
    { snapshot: async () => snapshot("$1") } as unknown as ToolContext,
    async () => ({
      release: () => {
        released += 1;
      },
      retain: () => {
        retained += 1;
      },
    }),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const encoded = Buffer.from(
    JSON.stringify({ after: "tmux://clients", fingerprint: "stale" }),
    "utf8",
  ).toString("base64url");
  try {
    await expect(
      client.listResources({ cursor: `libtmux.resources.v1.${encoded}` }),
    ).rejects.toThrow(/cursor/iu);
    expect(retained).toBe(0);
    expect(released).toBe(1);
  } finally {
    await client.close();
  }
});

test("does not retain catalog coverage for an unreachable server", async () => {
  let released = 0;
  let retained = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  mcp.server.registerCapabilities({ resources: {} });
  registerResourceCatalog(
    mcp,
    {
      snapshot: async () => {
        throw new Error("cannot reach tmux: executable not found");
      },
    } as unknown as ToolContext,
    async () => ({
      release: () => {
        released += 1;
      },
      retain: () => {
        retained += 1;
      },
    }),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  try {
    await expect(client.listResources()).rejects.toThrow("cannot reach tmux");
    expect(retained).toBe(0);
    expect(released).toBe(1);
  } finally {
    await client.close();
  }
});

test("shares the first topology reconciliation", async () => {
  const opening = Promise.withResolvers<LiveListener | undefined>();
  const opened = controlledListener();
  let attempts = 0;
  let snapshots = 0;
  const topology = watchTopology(
    contextWith(
      async () => {
        attempts += 1;
        return opening.promise;
      },
      async () => {
        snapshots += 1;
        return snapshot("$1");
      },
    ),
    () => undefined,
  );

  const first = topology.start();
  const second = topology.start();
  await Promise.resolve();
  expect(attempts).toBe(1);

  opening.resolve(opened.listener);
  await Promise.all([first, second]);
  expect(attempts).toBe(1);
  const snapshotsAfterStart = snapshots;
  expect(snapshotsAfterStart).toBeGreaterThan(0);
  await topology.start();
  expect(snapshots).toBe(snapshotsAfterStart);
  await topology.close();
});

test("covers linked windows without attaching to every session", async () => {
  const opened = new Map<string, ReturnType<typeof controlledListener>>();
  let events: ((event: TmuxEvent) => void) | undefined;
  let extraWindow = false;
  let secondAttempts = 0;
  const calls: string[] = [];
  const topology = watchTopology(
    contextWith(
      async (sessionId, listener) => {
        if (sessionId === "$2") {
          secondAttempts += 1;
          expect(opened.get("$1")?.stops()).toBe(0);
        }
        calls.push(sessionId);
        events = listener;
        if (sessionId === "$2" && secondAttempts === 1) return undefined;
        const controlled = controlledListener();
        opened.set(sessionId, controlled);
        return controlled.listener;
      },
      async () => linkedSnapshot(extraWindow),
    ),
    () => undefined,
  );

  await topology.start();
  expect(calls).toEqual(["$1"]);

  extraWindow = true;
  events?.({ kind: "window-add" } as TmuxEvent);
  await waitUntil(() => calls.length === 2, "new uncovered window did not gain a listener");
  expect(opened.get("$1")?.stops()).toBe(0);
  await waitUntil(() => calls.length === 3, "uncovered window listener did not retry");
  expect(calls).toEqual(["$1", "$2", "$2"]);
  expect(opened.get("$1")?.stops()).toBe(1);
  await topology.close();
});

test("removes a greedy session made redundant by the final cover", async () => {
  const calls: string[] = [];
  const topology = watchTopology(
    contextWith(
      async (sessionId) => {
        calls.push(sessionId);
        return controlledListener().listener;
      },
      async () => overlappingSnapshot(),
    ),
    () => undefined,
  );

  await topology.start();

  expect(calls).toEqual(["$2", "$3"]);
  await topology.close();
});

test("backs off failed listeners and announces one recovery", async () => {
  let attempts = 0;
  let events: ((event: TmuxEvent) => void) | undefined;
  let notices = 0;
  const opened = controlledListener();
  const topology = watchTopology(
    contextWith(async (_sessionId, listener) => {
      attempts += 1;
      if (attempts === 1) return undefined;
      if (attempts === 2) throw new Error("attach failed");
      events = listener;
      return opened.listener;
    }),
    () => {
      notices += 1;
    },
  );

  await topology.start();
  expect(attempts).toBe(1);
  expect(notices).toBe(0);
  await topology.start();
  expect(attempts).toBe(1);

  await waitUntil(() => attempts === 3 && notices === 1, "topology listener did not recover");
  events?.({ kind: "layout-change" } as TmuxEvent);
  expect(notices).toBe(2);
  await topology.close();
});

test("does not retry an unreachable server between requests", async () => {
  let snapshots = 0;
  const topology = watchTopology(
    contextWith(
      async () => undefined,
      async () => {
        snapshots += 1;
        throw new Error("cannot reach tmux: executable not found");
      },
    ),
    () => undefined,
  );
  try {
    await topology.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(snapshots).toBe(1);
  } finally {
    await topology.close();
  }
});

test("announces covered listener loss while recovery is already owed", async () => {
  const first = controlledListener();
  const replacement = controlledListener();
  const second = controlledListener();
  const openingSecond = Promise.withResolvers<LiveListener | undefined>();
  const calls: string[] = [];
  let notices = 0;
  const topology = watchTopology(
    contextWith(
      async (sessionId) => {
        calls.push(sessionId);
        if (calls.length === 1) return first.listener;
        if (calls.length === 2) return undefined;
        return sessionId === "$1" ? replacement.listener : openingSecond.promise;
      },
      async () => snapshot("$1", "$2"),
    ),
    () => {
      notices += 1;
    },
  );

  try {
    await topology.start();
    expect(calls).toEqual(["$1", "$2"]);
    expect(notices).toBe(0);

    first.end();
    await Promise.resolve();
    expect(notices).toBe(1);

    await waitUntil(() => calls.length === 4, "partial topology coverage did not retry");
    expect(calls).toEqual(["$1", "$2", "$1", "$2"]);
    expect(notices).toBe(1);

    openingSecond.resolve(second.listener);
    await waitUntil(() => notices === 2, "complete topology recovery was not announced");
    expect(notices).toBe(2);
  } finally {
    openingSecond.resolve(second.listener);
    await topology.close();
  }
});

test("stops a listener that opens after the topology watch closes", async () => {
  const opening = Promise.withResolvers<LiveListener | undefined>();
  const late = controlledListener();
  let attempts = 0;
  let notices = 0;
  const topology = watchTopology(
    contextWith(async () => {
      attempts += 1;
      return opening.promise;
    }),
    () => {
      notices += 1;
    },
  );

  const starting = topology.start();
  await waitUntil(() => attempts === 1, "topology listener did not start opening");
  const closing = topology.close();
  opening.resolve(late.listener);
  await Promise.all([starting, closing]);
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(late.stops()).toBe(1);
  expect(attempts).toBe(1);
  expect(notices).toBe(0);
});

test("topology close aborts and joins an in-flight snapshot", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  let snapshotSignal: AbortSignal | undefined;
  const topology = watchTopology(
    contextWith(
      async () => controlledListener().listener,
      async (signal) => {
        snapshotSignal = signal;
        entered.resolve();
        try {
          await release.promise;
          return snapshot("$1");
        } finally {
          settled.resolve();
        }
      },
    ),
    () => undefined,
  );

  const starting = topology.start();
  await entered.promise;
  const closing = topology.close();
  let closeSettled = false;
  void Promise.resolve(closing).then(() => {
    closeSettled = true;
  });
  try {
    expect(closing).toBeInstanceOf(Promise);
    expect(snapshotSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([starting, Promise.resolve(closing)]);
  }
  await settled.promise;
  expect(closeSettled).toBe(true);
});

test("keeps shared topology startup alive when one request is cancelled", async () => {
  const opening = Promise.withResolvers<LiveListener | undefined>();
  const opened = controlledListener();
  let attachSignal: AbortSignal | undefined;
  let attempts = 0;
  const topology = watchTopology(
    contextWith(async (_sessionId, _listener, signal) => {
      attempts += 1;
      attachSignal = signal;
      return opening.promise;
    }),
    () => undefined,
  );
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = topology.start(firstController.signal);
  const second = topology.start(secondController.signal);
  try {
    await waitUntil(() => attempts === 1, "shared topology listener did not start opening");
    firstController.abort();
    await expect(first).rejects.toBeDefined();
    expect(attachSignal?.aborted).toBe(false);

    opening.resolve(opened.listener);
    await second;
    expect(attempts).toBe(1);
    expect(opened.stops()).toBe(0);
  } finally {
    const closing = topology.close();
    opening.resolve(opened.listener);
    await Promise.allSettled([first, second, closing]);
  }
  expect(opened.stops()).toBe(1);
  expect(attachSignal?.aborted).toBe(true);
});

test("ignores a cancelled topology generation that opens under its replacement", async () => {
  const firstOpening = Promise.withResolvers<LiveListener | undefined>();
  const secondOpening = Promise.withResolvers<LiveListener | undefined>();
  const stale = controlledListener();
  const current = controlledListener();
  const attachSignals: AbortSignal[] = [];
  let attempts = 0;
  let notices = 0;
  const topology = watchTopology(
    contextWith(async (_sessionId, _listener, signal) => {
      attempts += 1;
      if (signal !== undefined) attachSignals.push(signal);
      return attempts === 1 ? firstOpening.promise : secondOpening.promise;
    }),
    () => {
      notices += 1;
    },
  );
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = topology.start(firstController.signal);
  let second: Promise<void> | undefined;
  let third: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitUntil(() => attempts === 1, "first topology generation did not start");
    firstController.abort();
    const outcome = await Promise.race([
      first.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"deadline">((resolve) => {
        deadline = setTimeout(() => resolve("deadline"), 250);
      }),
    ]);
    expect(outcome).toBe("settled");

    second = topology.start(secondController.signal);
    await waitUntil(() => attempts === 2, "replacement topology generation did not start");
    expect(attachSignals[0]?.aborted).toBe(true);
    expect(attachSignals[1]?.aborted).toBe(false);

    firstOpening.resolve(stale.listener);
    await waitUntil(() => stale.stops() === 1, "stale topology listener was not stopped");
    third = topology.start(secondController.signal);
    await Promise.resolve();
    expect(attempts).toBe(2);

    secondOpening.resolve(current.listener);
    await Promise.all([second, third]);
    expect(current.stops()).toBe(0);
    expect(notices).toBe(0);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    const closing = topology.close();
    firstOpening.resolve(stale.listener);
    secondOpening.resolve(current.listener);
    await Promise.allSettled([
      first,
      ...(second === undefined ? [] : [second]),
      ...(third === undefined ? [] : [third]),
      closing,
    ]);
  }
  expect(attachSignals[1]?.aborted).toBe(true);
});

test("drops a shared subscription after startup failure so a retry can succeed", async () => {
  const waiting = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const opened = controlledListener();
  let failing = true;
  let listens = 0;
  let snapshots = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  registerResourceSubscriptions(
    mcp,
    contextWith(
      async () => {
        listens += 1;
        return opened.listener;
      },
      async () => {
        snapshots += 1;
        if (snapshots === 1) {
          entered.resolve();
          await waiting.promise;
        }
        return failing ? snapshot("$1") : snapshotWithPane("%1");
      },
    ),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const uri = "tmux://panes/%251/content";
  const first = client.subscribeResource({ uri });
  let second: Promise<unknown> | undefined;
  try {
    await entered.promise;
    second = client.subscribeResource({ uri });
    await Promise.resolve();
    waiting.resolve();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    for (const outcome of outcomes) {
      expect(outcome.status === "rejected" ? String(outcome.reason) : "").toContain(
        "No pane %1 to subscribe to",
      );
    }
    expect(snapshots).toBe(1);

    failing = false;
    await client.subscribeResource({ uri });
    expect(listens).toBe(1);
    await client.unsubscribeResource({ uri });
    expect(opened.stops()).toBe(1);
  } finally {
    waiting.resolve();
    await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    await client.close();
  }
});

test("keeps shared subscription startup alive when one request is cancelled", async () => {
  const waiting = Promise.withResolvers<ServerSnapshot>();
  const entered = Promise.withResolvers<void>();
  const opened = controlledListener();
  let attachSignal: AbortSignal | undefined;
  let listens = 0;
  let snapshots = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  const dispose = registerResourceSubscriptions(
    mcp,
    contextWith(
      async (_sessionId, _listener, signal) => {
        listens += 1;
        attachSignal = signal;
        return opened.listener;
      },
      () => {
        snapshots += 1;
        entered.resolve();
        return waiting.promise;
      },
    ),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const controller = new AbortController();
  const uri = "tmux://panes/%251/content";
  const first = client.subscribeResource({ uri }, { signal: controller.signal });
  let second: Promise<unknown> | undefined;
  try {
    await entered.promise;
    second = client.subscribeResource({ uri });
    await Promise.resolve();
    expect(snapshots).toBe(1);
    controller.abort();
    waiting.resolve(snapshotWithPane("%1"));

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "fulfilled"]);
    expect(listens).toBe(1);
    expect(attachSignal?.aborted).toBe(false);

    await dispose();
    expect(opened.stops()).toBe(1);
    expect(attachSignal?.aborted).toBe(true);
  } finally {
    waiting.resolve(snapshotWithPane("%1"));
    await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    await client.close();
  }
});

test("subscription disposal aborts and joins an in-flight snapshot", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let snapshotSignal: AbortSignal | undefined;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  const dispose = registerResourceSubscriptions(
    mcp,
    contextWith(
      async () => controlledListener().listener,
      async (signal) => {
        snapshotSignal = signal;
        entered.resolve();
        await release.promise;
        return snapshotWithPane("%1");
      },
    ),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const subscribing = client.subscribeResource({ uri: "tmux://panes/%251/content" });
  await entered.promise;
  const closing = dispose();
  let closeSettled = false;
  void Promise.resolve(closing).then(() => {
    closeSettled = true;
  });
  try {
    expect(closing).toBeInstanceOf(Promise);
    expect(snapshotSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([subscribing, Promise.resolve(closing)]);
    await client.close();
  }
  expect(closeSettled).toBe(true);
});

test("does not retain a subscription whose request is cancelled", async () => {
  const opening = Promise.withResolvers<LiveListener | undefined>();
  const entered = Promise.withResolvers<void>();
  const cancelled = controlledListener();
  const retry = controlledListener();
  let attachSignal: AbortSignal | undefined;
  let listens = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  registerResourceSubscriptions(
    mcp,
    contextWith(
      async (_sessionId, _listener, signal) => {
        listens += 1;
        attachSignal = signal;
        entered.resolve();
        return listens === 1 ? opening.promise : retry.listener;
      },
      async () => snapshotWithPane("%1"),
    ),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const controller = new AbortController();
  const uri = "tmux://panes/%251/content";
  const subscribing = client.subscribeResource({ uri }, { signal: controller.signal });
  try {
    await entered.promise;
    controller.abort();
    await subscribing.catch(() => undefined);
    expect(attachSignal?.aborted).toBe(true);
    opening.resolve(cancelled.listener);
    await waitUntil(() => cancelled.stops() === 1, "late subscription listener was not stopped");

    await client.subscribeResource({ uri });
    expect(listens).toBe(2);
    await client.unsubscribeResource({ uri });
    expect(retry.stops()).toBe(1);
  } finally {
    opening.resolve(cancelled.listener);
    await Promise.allSettled([subscribing]);
    await client.close();
  }
});

test("verifies same-session pane moves and announces layout updates", async () => {
  const opened = controlledListener();
  let currentWindow = "@1";
  let events: ((event: TmuxEvent) => void) | undefined;
  let movedFromSecond = false;
  let observedThird = false;
  let snapshots = 0;
  const mcp = new McpServer({ name: "resource-watch-test", version: "0" });
  registerResourceSubscriptions(
    mcp,
    contextWith(
      async (_sessionId, listener) => {
        events = listener;
        return opened.listener;
      },
      async () => {
        snapshots += 1;
        const observed = currentWindow;
        if (observed === "@2" && !movedFromSecond) {
          movedFromSecond = true;
          queueMicrotask(() => {
            currentWindow = "@3";
            events?.({ kind: "layout-change", windowId: "@2" } as TmuxEvent);
          });
        }
        if (observed === "@3") observedThird = true;
        return snapshotWithPane("%1", observed);
      },
    ),
  );
  const client = new Client({ name: "resource-watch-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  const uri = "tmux://panes/%251/content";
  let updates = 0;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
    updates += 1;
  });
  try {
    await client.subscribeResource({ uri });

    currentWindow = "@2";
    events?.({ kind: "layout-change", windowId: "@1" } as TmuxEvent);
    await waitUntil(() => observedThird, "same-session pane move was not verified");
    await waitUntil(() => updates > 0, "layout change did not announce changed pane contents");

    const before = snapshots;
    const updatesBefore = updates;
    for (let index = 0; index < 10; index += 1) {
      events?.({ kind: "layout-change", windowId: "@3" } as TmuxEvent);
    }
    await waitUntil(() => snapshots > before, "latest pane window was not tracked");
    await waitUntil(
      () => updates > updatesBefore,
      "layout burst did not announce changed contents",
    );
    expect(snapshots).toBe(before + 1);
    expect(updates).toBe(updatesBefore + 1);
  } finally {
    await client.unsubscribeResource({ uri }).catch(() => undefined);
    await client.close();
  }
});
