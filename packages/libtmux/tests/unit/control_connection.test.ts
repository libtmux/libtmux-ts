import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { ControlConnection } from "../../src/_internal/control/connection.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: "SIGKILL" | "SIGTERM" | null = null;
  readonly kills: ("SIGKILL" | "SIGTERM")[] = [];

  constructor(readonly pid: number) {
    super();
  }

  kill(signal: "SIGKILL" | "SIGTERM"): boolean {
    this.kills.push(signal);
    this.signalCode = signal;
    this.emit("close", null);
    return true;
  }
}

class RecordingTransport implements CommandTransport {
  readonly requests: CommandRequest[] = [];

  async execute(request: CommandRequest): Promise<RawCommandResult> {
    this.requests.push(request);
    return {
      cmd: request.args,
      returncode: 0,
      signal: null,
      stderr: new Uint8Array(),
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
    const control = new ControlConnection(
      connection(),
      { pauseAfterSeconds: 3, reconnect: { attempts: 1, delayMs: 1 } },
      false,
      fallback,
      () => children.shift() as unknown as ChildProcessWithoutNullStreams,
    );
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
      () => child as unknown as ChildProcessWithoutNullStreams,
    );
    attach(child);
    await control.ready();
    const result = control.execute({ args: ["show-buffer", "-b", "flow"], executable: "tmux" });
    child.stdout.write("%begin 2 3 1\n%pause %1\n%continue %1\n%end 2 3 1\n");
    expect(new TextDecoder().decode((await result).stdout)).toBe("%pause %1\n%continue %1\n");
    await control.close();
  });
});
