import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import type { ControlChild } from "../../src/_internal/control/child.js";
import { ControlConnection } from "../../src/_internal/control/connection.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { parsePaneId } from "../../src/_internal/runtime/ids.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";

class FakeChild extends EventEmitter implements ControlChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: "SIGKILL" | "SIGTERM" | null = null;
  readonly kills: ("SIGKILL" | "SIGTERM")[] = [];
  readonly pid: number;
  readonly #closeOnKill: boolean;

  constructor(pid: number, closeOnKill = true) {
    super();
    this.pid = pid;
    this.#closeOnKill = closeOnKill;
  }

  kill(signal: "SIGKILL" | "SIGTERM"): boolean {
    this.kills.push(signal);
    this.signalCode = signal;
    if (this.#closeOnKill) this.emit("close", null);
    return true;
  }
}

function takeChild(children: FakeChild[]): FakeChild {
  const child = children.shift();
  if (child === undefined) throw new Error("no fake control child remains");
  return child;
}

class RecordingTransport implements CommandTransport {
  readonly requests: CommandRequest[] = [];
  readonly #outcome: Error | number;

  constructor(outcome: Error | number = 0) {
    this.#outcome = outcome;
  }

  async execute(request: CommandRequest): Promise<RawCommandResult> {
    this.requests.push(request);
    if (this.#outcome instanceof Error) throw this.#outcome;
    return {
      cmd: [request.executable, ...flattenInvocation(request)],
      returncode: this.#outcome,
      signal: null,
      stderr: this.#outcome === 0 ? new Uint8Array() : new TextEncoder().encode("resume refused"),
      stdout: new Uint8Array(),
    };
  }
}

function connection(): TmuxConnection {
  return new TmuxConnection({ executable: "tmux", socketPath: "/tmp/libtmux-control-test" });
}

function attach(child: FakeChild): void {
  child.stdout.write("%begin 1 2 0\n%end 1 2 0\n");
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function promiseState(
  promise: Promise<unknown>,
): Promise<"pending" | "rejected" | "resolved"> {
  let state: "pending" | "rejected" | "resolved" = "pending";
  void promise.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  await Promise.resolve();
  return state;
}

function reconnectingFixture(firstPid: number) {
  const first = new FakeChild(firstPid);
  const replacement = new FakeChild(firstPid + 1);
  const children = [first, replacement];
  const replacementOpened = Promise.withResolvers<void>();
  let spawns = 0;
  const control = new ControlConnection(
    connection(),
    { reconnect: { attempts: 1, delayMs: 0 } },
    false,
    undefined,
    () => {
      const child = takeChild(children);
      spawns += 1;
      if (spawns === 2) replacementOpened.resolve();
      return child;
    },
  );
  return { control, first, replacement, replacementOpened: replacementOpened.promise };
}

describe("ControlConnection child ownership", () => {
  test("waits for a replacement attach during reconnect", async () => {
    const { control, first, replacement, replacementOpened } = reconnectingFixture(98);
    const events = control.subscribe();
    const iterator = events[Symbol.asyncIterator]();
    attach(first);
    await control.ready();

    const reconnecting = iterator.next();
    first.emit("close", 1);
    expect((await reconnecting).value).toEqual({ attempts: 1, kind: "reconnecting" });

    const readiness = control.ready();
    expect(await promiseState(readiness)).toBe("pending");
    await replacementOpened;
    expect(await promiseState(readiness)).toBe("pending");

    const reconnected = iterator.next();
    attach(replacement);
    await readiness;
    expect((await reconnected).value).toEqual({ attempts: 1, kind: "reconnected" });
    expect(await promiseState(control.ready())).toBe("resolved");
    await iterator.return?.();
    await control.close();
  });

  test("keeps the initial readiness waiter across an attach retry", async () => {
    const { control, first, replacement, replacementOpened } = reconnectingFixture(96);
    const events = control.subscribe();
    const iterator = events[Symbol.asyncIterator]();
    const readiness = control.ready();

    const reconnecting = iterator.next();
    first.emit("close", 1);
    expect((await reconnecting).value).toEqual({ attempts: 1, kind: "reconnecting" });
    expect(await promiseState(readiness)).toBe("pending");
    await replacementOpened;
    const retryReadiness = control.ready();
    expect(await promiseState(readiness)).toBe("pending");
    expect(await promiseState(retryReadiness)).toBe("pending");

    const reconnected = iterator.next();
    attach(replacement);
    await Promise.all([readiness, retryReadiness]);
    expect((await reconnected).value).toEqual({ attempts: 1, kind: "reconnected" });
    expect(await promiseState(control.ready())).toBe("resolved");
    await iterator.return?.();
    await control.close();
  });

  test("rejects readiness when reconnect attempts are exhausted", async () => {
    const { control, first, replacement, replacementOpened } = reconnectingFixture(94);
    const events = control.subscribe();
    const iterator = events[Symbol.asyncIterator]();
    attach(first);
    await control.ready();

    const reconnecting = iterator.next();
    first.emit("close", 1);
    expect((await reconnecting).value).toEqual({ attempts: 1, kind: "reconnecting" });
    const duringOutage = control.ready();
    expect(await promiseState(duringOutage)).toBe("pending");
    await replacementOpened;
    const ended = iterator.next();
    replacement.stderr.write("terminal replacement failed");
    replacement.emit("close", 1);

    await expect(duringOutage).rejects.toThrow("terminal replacement failed");
    await expect(control.ready()).rejects.toThrow("terminal replacement failed");
    await expect(ended).rejects.toThrow("terminal replacement failed");
    await control.close();
  });

  test("retires a stale child before configuring its replacement", async () => {
    const old = new FakeChild(101);
    const replacement = new FakeChild(102);
    const children = [old, replacement];
    const fallback = new RecordingTransport();
    const reconnect = { attempts: 1, delayMs: 1 };
    const control = new ControlConnection(
      connection(),
      { pauseAfterSeconds: 3, reconnect },
      false,
      fallback,
      () => takeChild(children),
    );
    reconnect.attempts = 0;
    reconnect.delayMs = 0;
    const reconnectingEvents = control.subscribe();
    const reconnectedEvents = control.subscribe();
    const staleEvents = control.subscribe();
    attach(old);
    await Promise.all([reconnectingEvents.ready(), reconnectedEvents.ready(), staleEvents.ready()]);
    expect(fallback.requests).toHaveLength(1);
    expect(fallback.requests[0]?.commands[0]).toContain("client-101");

    const reconnecting = reconnectingEvents.find((event) => event.kind === "reconnecting", {
      timeoutMs: 1_000,
    });
    old.emit("error", new Error("broken pipe"));
    old.emit("close", 1);
    expect(await reconnecting).toEqual({ attempts: 1, kind: "reconnecting" });
    expect(old.kills).toEqual(["SIGTERM"]);
    await nextTurn();
    await nextTurn();

    const reconnected = reconnectedEvents.find((event) => event.kind === "reconnected", {
      timeoutMs: 1_000,
    });
    // Retired output must not become an observer event on the replacement.
    old.stdout.write("%pause %1\n");
    attach(replacement);
    expect(await reconnected).toEqual({ attempts: 1, kind: "reconnected" });
    expect(fallback.requests).toHaveLength(2);
    expect(fallback.requests[1]?.commands[0]).toContain("client-102");
    expect(
      await staleEvents.find((event) => event.kind === "pause", { timeoutMs: 10 }),
    ).toBeUndefined();

    await control.close();
    expect(replacement.kills).toEqual(["SIGTERM"]);
  });

  test("drops an incomplete pane character across a pause gap", async () => {
    const child = new FakeChild(105);
    const control = new ControlConnection(
      connection(),
      {},
      false,
      new RecordingTransport(),
      () => child,
    );
    const events = control.subscribe();
    const iterator = events[Symbol.asyncIterator]();
    attach(child);
    await events.ready();

    child.stdout.write(Buffer.concat([Buffer.from("%output %1 "), Buffer.from([0xc3, 0x0a])]));
    expect((await iterator.next()).value).toEqual({
      data: "",
      kind: "output",
      paneId: parsePaneId("%1"),
    });
    child.stdout.write("%pause %1\n%continue %1\n%output %1 x\n");
    expect((await iterator.next()).value).toEqual({ kind: "pause", paneId: parsePaneId("%1") });
    expect((await iterator.next()).value).toEqual({ kind: "continue", paneId: parsePaneId("%1") });
    expect((await iterator.next()).value).toEqual({
      data: "x",
      kind: "output",
      paneId: parsePaneId("%1"),
    });

    await iterator.return?.();
    await control.close();
  });

  test("fails the stream when pane resume fails", async () => {
    await Promise.all(
      [1, new Error("resume transport failed")].map(async (outcome, index) => {
        const child = new FakeChild(106 + index);
        const fallback = new RecordingTransport(outcome);
        const control = new ControlConnection(connection(), {}, false, fallback, () => child);
        const events = control.subscribe();
        attach(child);
        await events.ready();

        const ended = events.find(() => false, { timeoutMs: 1_000 });
        child.stdout.write("%pause %1\n");
        await expect(ended).rejects.toThrow();
        expect(fallback.requests[0]?.commands[0]).toContain("%1:continue");
        await control.close();
      }),
    );
  });

  test("bounds one oversized stderr chunk to its diagnostic tail", async () => {
    const child = new FakeChild(108);
    const control = new ControlConnection(connection(), {}, false, undefined, () => child);
    const ready = control.ready();
    child.stderr.write(Buffer.concat([Buffer.alloc(256 * 1_024, "x"), Buffer.from("tail-marker")]));
    child.emit("close", 1);

    try {
      await ready;
      throw new Error("expected control attachment to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message.length).toBeLessThanOrEqual(64 * 1_024 + 64);
      expect(error.message).toEndWith("tail-marker");
    }
    await control.close();
  });

  test("bounds one oversized attach diagnostic line", async () => {
    const child = new FakeChild(109);
    const control = new ControlConnection(connection(), {}, false, undefined, () => child);
    const ready = control.ready();
    child.stdout.write(
      Buffer.concat([
        Buffer.from("%begin 1 2 0\n"),
        Buffer.alloc(256 * 1_024, "x"),
        Buffer.from("\n%error 1 2 0\n"),
      ]),
    );
    child.emit("close", 1);

    try {
      await ready;
      throw new Error("expected control attachment to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message.length).toBeLessThanOrEqual(64 * 1_024 + 64);
    }
    await control.close();
  });

  test("makes concurrent close callers await child retirement", async () => {
    const child = new FakeChild(110, false);
    const control = new ControlConnection(connection(), {}, false, undefined, () => child);
    attach(child);
    await control.ready();

    const first = control.close();
    const second = control.close();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);

    child.exitCode = 0;
    child.emit("close", 0);
    await Promise.all([first, second]);
  });

  test("rejects invalid reconnect timing before spawning", () => {
    for (const [field, reconnect] of [
      ["attempts", { attempts: 0 }],
      ["attempts", { attempts: Number.NaN }],
      ["attempts", { attempts: 1.5 }],
      ["delayMs", { attempts: 1, delayMs: -1 }],
      ["delayMs", { attempts: 1, delayMs: Number.POSITIVE_INFINITY }],
      ["delayMs", { attempts: 1, delayMs: 1.5 }],
      ["delayMs", { attempts: 2, delayMs: 1_073_741_824 }],
    ] as const) {
      let spawns = 0;
      expect(
        () =>
          new ControlConnection(connection(), { reconnect }, false, undefined, () => {
            spawns += 1;
            return new FakeChild(110);
          }),
      ).toThrow(field);
      expect(spawns).toBe(0);
    }
  });
});
