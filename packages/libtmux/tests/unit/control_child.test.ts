import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import { type ControlChild, ControlChildLifecycle } from "../../src/_internal/control/child.js";

class FakeChild extends EventEmitter implements ControlChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), {
    destroy: () => {
      this.stdinDestroyed = true;
    },
    write: (_line: string, callback: (error?: Error | null) => void) => {
      this.writeCallback = callback;
      return true;
    },
  });
  readonly kills: ("SIGKILL" | "SIGTERM")[] = [];
  stdinDestroyed = false;
  writeCallback: ((error?: Error | null) => void) | undefined;
  exitCode: number | null = null;
  signalCode: "SIGKILL" | "SIGTERM" | null = null;

  kill(signal: "SIGKILL" | "SIGTERM"): boolean {
    this.kills.push(signal);
    return true;
  }
}

function takeChild(children: FakeChild[]): FakeChild {
  const child = children.shift();
  if (child === undefined) throw new Error("no fake control child remains");
  return child;
}

const handlers = (output: string[], failures: Error[] = []) => ({
  close: () => undefined,
  error: (error: Error) => failures.push(error),
  stderr: () => undefined,
  stdinDrain: () => undefined,
  stdinError: () => undefined,
  stdout: (chunk: Buffer) => output.push(chunk.toString("utf8")),
});

describe("control child lifecycle", () => {
  test("retires one generation once and silences its late callbacks", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    const output: string[] = [];
    const failures: Error[] = [];
    const lifecycle = new ControlChildLifecycle(() => takeChild(children), {
      terminationGraceMs: 10_000,
    });

    lifecycle.open(handlers(output, failures));
    lifecycle.write("first", (error) => failures.push(error));
    expect(lifecycle.retire()).toBe(first);
    expect(lifecycle.retire()).toBeUndefined();
    lifecycle.open(handlers(output, failures));

    first.stdout.emit("data", Buffer.from("stale"));
    first.emit("error", new Error("stale child"));
    first.stdin.emit("error", new Error("stale stdin"));
    first.emit("close", 1);
    first.writeCallback?.(new Error("stale write"));
    second.stdout.emit("data", Buffer.from("replacement"));

    expect(output).toEqual(["replacement"]);
    expect(failures).toEqual([]);
    expect(first.stdinDestroyed).toBe(true);
    expect(first.kills).toEqual(["SIGTERM"]);
    lifecycle.retire();
  });

  test("forces a child that ignores graceful retirement", async () => {
    const child = new FakeChild();
    const lifecycle = new ControlChildLifecycle(() => child, {
      terminationGraceMs: 1,
    });
    lifecycle.open(handlers([]));

    lifecycle.retire();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("does not force a child that closes during retirement", async () => {
    const child = new FakeChild();
    const lifecycle = new ControlChildLifecycle(() => child, {
      terminationGraceMs: 1,
    });
    lifecycle.open(handlers([]));

    lifecycle.retire();
    child.emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(child.kills).toEqual(["SIGTERM"]);
  });
});
