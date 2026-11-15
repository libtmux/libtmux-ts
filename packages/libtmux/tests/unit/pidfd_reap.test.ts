import { describe, expect, test } from "bun:test";

import {
  POLLERR,
  POLLIN,
  POLLNVAL,
  reapByPidfd,
  type PidfdOps,
  type PidfdTarget,
} from "../../src/_internal/test/pidfd_reap.js";

const BOOT = "00000000-0000-4000-8000-000000000000";
const DESCRIPTOR = 91;
const TARGET: PidfdTarget = {
  argv: ["/owned/tmux", "-S", "/owned/s", "start-server"],
  comm: "tmux: server",
  executable: "/owned/tmux",
  generationName: "GEN",
  generationValue: "owned",
  pid: 17,
  startIdentity: `linux:${BOOT}:42`,
};

type Field = "argv" | "comm" | "executable" | "generation" | "starttime";
type PollEvents = readonly { descriptor: number; events: number }[];

interface World {
  /** Which identity check sees the change, counted from 1. */
  readonly phase?: number;
  readonly field?: Field | "exit" | "zombie";
  /** What `poll(0)` reports after the TERM wait. */
  readonly events?: PollEvents;
  /** The descriptor `poll` reports once the process is gone. */
  readonly exitsAfter?: "kill" | "term";
  readonly openFailure?: string;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
}

/** A `/proc` for pid 17 and the pidfd calls over it, recording what was sent. */
function world(options: World = {}) {
  const state = {
    checks: 0,
    closed: [] as number[],
    polls: [] as number[],
    signals: [] as string[],
  };
  const changed = (field: Field): boolean =>
    options.field === field && state.checks === options.phase;
  const zombie = (): boolean => options.field === "zombie" && state.checks >= (options.phase ?? 0);
  const ops: PidfdOps = {
    close: (descriptor) => void state.closed.push(descriptor),
    open: () => {
      if (options.openFailure !== undefined) {
        throw Object.assign(new Error("pidfd_open failed"), { code: options.openFailure });
      }
      return DESCRIPTOR;
    },
    poll: (_descriptor, timeoutMs) => {
      state.polls.push(timeoutMs);
      if (timeoutMs === 0) return options.events ?? [];
      const exited =
        (timeoutMs === 500 && options.exitsAfter === "term") ||
        (timeoutMs === 2000 && options.exitsAfter !== undefined);
      return exited ? [{ descriptor: DESCRIPTOR, events: POLLIN }] : [];
    },
    readFile: (path) => {
      switch (path) {
        case "/proc/sys/kernel/random/boot_id":
          state.checks += 1;
          return encode(BOOT);
        case "/proc/17/comm":
          return encode(changed("comm") ? "foreign" : "tmux: server");
        case "/proc/17/stat":
          return encode(
            `17 (tmux: server) ${[zombie() ? "Z" : "S", ...Array<string>(18).fill("0"), changed("starttime") ? "43" : "42"].join(" ")}`,
          );
        case "/proc/17/cmdline":
          return zombie()
            ? new Uint8Array()
            : encode(`${(changed("argv") ? ["/foreign"] : TARGET.argv).join("\0")}\0`);
        case "/proc/17/environ":
          return zombie()
            ? new Uint8Array()
            : encode(changed("generation") ? "GEN=foreign\0" : "GEN=owned\0");
        default:
          throw enoent(path);
      }
    },
    // An exited daemon's exe link stops resolving, so it stays the path itself.
    realpath: (path) =>
      changed("executable")
        ? "/foreign/tmux"
        : options.field === "exit" && state.checks === options.phase
          ? path
          : zombie()
            ? path
            : "/owned/tmux",
    sendSignal: (_descriptor, signal) => void state.signals.push(signal),
  };
  return { ops, state };
}

describe("pidfd reaper", () => {
  test("refuses a daemon that changed before any signal, and never signals it", () => {
    const fields: readonly Field[] = ["starttime", "comm", "executable", "argv", "generation"];
    for (const phase of [1, 2, 3]) {
      for (const field of fields) {
        const { ops, state } = world({ field, phase });
        const { exitCode, report } = reapByPidfd(TARGET, ops);
        const label = `${field} changed at check ${String(phase)}`;

        expect([exitCode, report.status], label).toEqual([3, "identity-mismatch"]);
        // Only the third check follows the TERM, which the pidfd already named.
        expect(state.signals, label).toEqual(phase === 3 ? ["SIGTERM"] : []);
        expect(state.closed, label).toEqual(phase > 1 ? [DESCRIPTOR] : []);
      }
    }
  });

  test("accepts only authenticated pidfd exit readiness after TERM", () => {
    const readiness: readonly [PollEvents, boolean][] = [
      [[{ descriptor: DESCRIPTOR, events: POLLIN }], true],
      [[{ descriptor: DESCRIPTOR, events: POLLIN | 16 }], true],
      [[], false],
      [[{ descriptor: DESCRIPTOR, events: POLLERR }], false],
      [[{ descriptor: DESCRIPTOR, events: POLLNVAL }], false],
      [[{ descriptor: DESCRIPTOR, events: POLLIN | POLLERR }], false],
      [[{ descriptor: DESCRIPTOR, events: POLLIN | POLLNVAL }], false],
      [[{ descriptor: DESCRIPTOR, events: 16 }], false],
      [[{ descriptor: DESCRIPTOR + 1, events: POLLIN }], false],
    ];
    for (const [events, exited] of readiness) {
      const { ops, state } = world({ events, field: "exit", phase: 3 });
      const { exitCode, report } = reapByPidfd(TARGET, ops);
      const label = JSON.stringify(events);

      expect([exitCode, report.status], label).toEqual(
        exited ? [0, "gone"] : [3, "identity-mismatch"],
      );
      expect(state.signals, label).toEqual(["SIGTERM"]);
    }
  });

  test("reads an exited, unreaped daemon as gone", () => {
    for (const phase of [1, 2, 3]) {
      const { ops } = world({ field: "zombie", phase });

      expect(reapByPidfd(TARGET, ops)).toEqual({ exitCode: 0, report: { status: "gone" } });
    }
  });

  test("stops at TERM when the daemon exits, and escalates to KILL when it does not", () => {
    const polite = world({ exitsAfter: "term" });
    expect(reapByPidfd(TARGET, polite.ops)).toEqual({
      exitCode: 0,
      report: { escalated: false, status: "reaped" },
    });
    expect(polite.state.signals).toEqual(["SIGTERM"]);

    const stubborn = world({ exitsAfter: "kill" });
    expect(reapByPidfd(TARGET, stubborn.ops)).toEqual({
      exitCode: 0,
      report: { escalated: true, status: "reaped" },
    });
    expect(stubborn.state.signals).toEqual(["SIGTERM", "SIGKILL"]);

    const survivor = world();
    expect(reapByPidfd(TARGET, survivor.ops)).toEqual({
      exitCode: 4,
      report: { status: "still-live" },
    });
    expect(survivor.state.closed).toEqual([DESCRIPTOR]);
  });

  test("says a daemon is gone when its pid is, and unavailable when the platform has no pidfd", () => {
    expect(reapByPidfd(TARGET, world({ openFailure: "ESRCH" }).ops).report.status).toBe("gone");

    const unavailable = reapByPidfd(TARGET, world({ openFailure: "ENOSYS" }).ops);
    expect(unavailable.exitCode).toBe(5);
    expect(unavailable.report).toEqual({ error: "pidfd_open failed", status: "unavailable" });
  });
});
