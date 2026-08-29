import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import type { ControlChild } from "../../src/_internal/control/child.js";
import { ControlConnection } from "../../src/_internal/control/connection.js";
import { parsePaneId } from "../../src/_internal/runtime/ids.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";

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
      cmd: request.args,
      returncode: this.#outcome,
      signal: null,
      stderr: this.#outcome === 0 ? new Uint8Array() : new TextEncoder().encode("resume refused"),
      stdout: new Uint8Array(),
    };
  }

  async executeGroup(requests: readonly CommandRequest[]): Promise<readonly RawCommandResult[]> {
    return Promise.all(requests.map((request) => this.execute(request)));
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

describe("ControlConnection child ownership", () => {
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
    expect(fallback.requests[0]?.args).toContain("client-101");

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
    expect(fallback.requests[1]?.args).toContain("client-102");
    expect(
      await staleEvents.find((event) => event.kind === "pause", { timeoutMs: 10 }),
    ).toBeUndefined();

    await control.close();
    expect(replacement.kills).toEqual(["SIGTERM"]);
  });

  test("keeps exact flow-shaped command output literal", async () => {
    const child = new FakeChild(103);
    const control = new ControlConnection(
      connection(),
      {},
      false,
      new RecordingTransport(),
      () => child,
    );
    attach(child);
    await control.ready();
    const result = control.execute({ args: ["show-buffer", "-b", "flow"], executable: "tmux" });
    child.stdout.write("%begin 2 3 1\n%pause %1\n%continue %1\n%end 2 3 1\n");
    expect(new TextDecoder().decode((await result).stdout)).toBe("%pause %1\n%continue %1\n");
    await control.close();
  });

  test("does not carry output-shaped command bytes into pane output", async () => {
    const child = new FakeChild(104);
    const control = new ControlConnection(
      connection(),
      {},
      false,
      new RecordingTransport(),
      () => child,
    );
    const events = control.subscribe();
    attach(child);
    await events.ready();
    const result = control.execute({ args: ["show-buffer", "-b", "bytes"], executable: "tmux" });
    child.stdout.write(
      Buffer.concat([
        Buffer.from("%begin 2 3 1\n%output %1 "),
        Buffer.from([0xc3]),
        Buffer.from("\n%end 2 3 1\n%output %1 pane\n"),
      ]),
    );

    await result;
    expect(await events.find((event) => event.kind === "output", { timeoutMs: 1_000 })).toEqual({
      data: "pane",
      kind: "output",
      paneId: parsePaneId("%1"),
    });
    await events.close();
    await control.close();
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
        expect(fallback.requests[0]?.args).toContain("%1:continue");
        await control.close();
      }),
    );
  });

  test("makes concurrent close callers await child retirement", async () => {
    const child = new FakeChild(108, false);
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
            return new FakeChild(109);
          }),
      ).toThrow(field);
      expect(spawns).toBe(0);
    }
  });
});
