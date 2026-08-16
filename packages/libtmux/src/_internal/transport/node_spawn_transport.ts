import type { AbortLike } from "../../types.js";
import { spawn } from "node:child_process";

import type { Readable } from "node:stream";

import type { DeliveryStatus } from "../../common.js";
import type { CommandRequest, RawCommandResult } from "./types.js";
import {
  assembleGroupArgv,
  createGroupSeparator,
  MAX_PACKED_ARGV_BYTES,
  packedArgvBytes,
} from "./group.js";
import { snapshotCommandRequest, TmuxTransportError } from "./types.js";

export interface NodeSpawnTransportOptions {
  readonly postKillGraceMs?: number;
  readonly terminationGraceMs?: number;
}

interface ClosedProcess {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function collect(stream: Readable, chunks: Buffer[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stream.removeListener("close", onClose);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(collectedBytes(chunks));
    };
    const onClose = (): void => finish();
    const onData = (chunk: Buffer | Uint8Array): void => {
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

function collectedBytes(chunks: readonly Buffer[]): Uint8Array {
  return Buffer.concat(chunks);
}

function isAborted(signal: AbortLike | undefined): boolean {
  return signal?.aborted === true;
}

export class NodeSpawnTransport {
  readonly #postKillGraceMs: number;
  readonly #terminationGraceMs: number;

  constructor(options: NodeSpawnTransportOptions = {}) {
    this.#postKillGraceMs = options.postKillGraceMs ?? 250;
    this.#terminationGraceMs = options.terminationGraceMs ?? 100;
  }

  async execute(request: CommandRequest): Promise<RawCommandResult> {
    const submitted = snapshotCommandRequest(request);
    if (isAborted(submitted.signal)) {
      throw new TmuxTransportError("command cancelled before spawn", {
        delivery: "not_started",
        kind: "cancelled",
      });
    }
    const stdin = submitted.stdin;

    let child;
    try {
      child = spawn(submitted.executable, [...submitted.args], {
        env: submitted.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // Name the executable and the reason. "spawn failed" sends a reader
      // looking through their own code for a bug that is a missing binary or
      // a wrong path.
      const code = (error as NodeJS.ErrnoException).code;
      throw new TmuxTransportError(
        `could not run ${submitted.executable}${code === undefined ? "" : ` (${code})`}`,
        { cause: error, delivery: "not_started", kind: "spawn" },
      );
    }

    let closed = false;
    let drainageDiscarded = false;
    let interruption: "cancelled" | "timeout" | undefined;
    let observedExit: ClosedProcess | undefined;
    let delivery: DeliveryStatus = "not_started";
    let escalationTimer: NodeJS.Timeout | undefined;
    let postKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let spawnError: unknown;
    let stdinError: unknown;
    let forcedSettlement = false;
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];

    let settleLifecycle!: (value: ClosedProcess) => void;
    const lifecyclePromise = new Promise<ClosedProcess>((resolve) => {
      settleLifecycle = resolve;
    });

    const clearLifecycleTimers = (): void => {
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (postKillTimer !== undefined) clearTimeout(postKillTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    };

    const removeAbortListener = (): void => {
      submitted.signal?.removeEventListener("abort", onAbort);
    };

    const discardDrainage = (): void => {
      if (drainageDiscarded) return;
      drainageDiscarded = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const forceSettlement = (): void => {
      if (closed || forcedSettlement) return;
      forcedSettlement = true;
      discardDrainage();
      child.removeListener("close", onClose);
      child.unref();
      clearLifecycleTimers();
      removeAbortListener();
      settleLifecycle(observedExit ?? { code: null, signal: null });
    };

    const armHardSettlement = (): void => {
      postKillTimer ??= setTimeout(forceSettlement, this.#postKillGraceMs);
    };

    const terminate = (): void => {
      child.stdin.destroy();
      if (closed || forcedSettlement || observedExit !== undefined) return;
      child.kill("SIGTERM");
      escalationTimer ??= setTimeout(() => {
        if (closed || forcedSettlement || observedExit !== undefined) return;
        child.kill("SIGKILL");
        armHardSettlement();
      }, this.#terminationGraceMs);
      escalationTimer.unref();
    };

    const interrupt = (kind: "cancelled" | "timeout"): void => {
      if (interruption !== undefined) return;
      if (observedExit !== undefined) {
        discardDrainage();
        armHardSettlement();
        return;
      }
      interruption = kind;
      if (delivery === "written" || child.pid !== undefined) delivery = "indeterminate";
      terminate();
    };
    const onAbort = (): void => {
      interrupt("cancelled");
    };

    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.once("spawn", () => {
      if (interruption !== undefined) {
        delivery = "indeterminate";
        terminate();
        return;
      }
      delivery = "written";
      child.stdin.end(stdin);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      observedExit = { code, signal };
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (interruption !== undefined) {
        discardDrainage();
        armHardSettlement();
      }
    });

    const stdoutPromise = collect(child.stdout, stdoutChunks);
    const stderrPromise = collect(child.stderr, stderrChunks);
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      closed = true;
      clearLifecycleTimers();
      removeAbortListener();
      settleLifecycle({ code, signal });
    }
    child.once("close", onClose);

    submitted.signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted(submitted.signal)) onAbort();
    if (submitted.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => interrupt("timeout"), submitted.timeoutMs);
      timeoutTimer.unref();
    }

    const stdoutStatePromise = stdoutPromise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ reason, status: "rejected" as const }),
    );
    const stderrStatePromise = stderrPromise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ reason, status: "rejected" as const }),
    );

    const close = await lifecyclePromise;
    const [stdoutState, stderrState] = forcedSettlement
      ? [
          { status: "fulfilled" as const, value: collectedBytes(stdoutChunks) },
          { status: "fulfilled" as const, value: collectedBytes(stderrChunks) },
        ]
      : await Promise.all([stdoutStatePromise, stderrStatePromise]);

    if (interruption !== undefined) {
      throw new TmuxTransportError(
        interruption === "timeout" ? "command timed out" : "command cancelled",
        {
          delivery,
          kind: interruption,
          ...(observedExit === undefined ? {} : { signal: observedExit.signal }),
          ...(stderrState.status === "fulfilled" ? { stderr: stderrState.value } : {}),
          ...(stdoutState.status === "fulfilled" ? { stdout: stdoutState.value } : {}),
        },
      );
    }
    if (spawnError !== undefined) {
      // spawn reports a missing or unexecutable binary here rather than by
      // throwing, so this is the path a wrong tmuxBin actually takes.
      const code = (spawnError as NodeJS.ErrnoException).code;
      throw new TmuxTransportError(
        `could not run ${submitted.executable}${code === undefined ? "" : ` (${code})`}`,
        {
          cause: spawnError,
          delivery: "not_started",
          kind: "spawn",
          signal: close.signal,
        },
      );
    }
    if (stdinError !== undefined) {
      throw new TmuxTransportError("command stdin failed", {
        cause: stdinError,
        delivery: "indeterminate",
        kind: "pipe",
        signal: close.signal,
      });
    }
    if (stdoutState.status === "rejected" && !drainageDiscarded) {
      throw new TmuxTransportError("command output failed", {
        cause: stdoutState.reason,
        delivery: "indeterminate",
        kind: "pipe",
        signal: close.signal,
      });
    }
    if (stderrState.status === "rejected" && !drainageDiscarded) {
      throw new TmuxTransportError("command output failed", {
        cause: stderrState.reason,
        delivery: "indeterminate",
        kind: "pipe",
        signal: close.signal,
      });
    }
    const terminal = observedExit ?? close;
    if (terminal.code === null) {
      throw new TmuxTransportError("command closed without an exit code", {
        delivery: "indeterminate",
        kind: "protocol",
        signal: terminal.signal,
      });
    }

    return {
      cmd: Object.freeze([submitted.executable, ...submitted.args]),
      returncode: terminal.code,
      signal: terminal.signal,
      stderr: stderrState.status === "fulfilled" ? stderrState.value : new Uint8Array(),
      stdout: stdoutState.status === "fulfilled" ? stdoutState.value : new Uint8Array(),
    };
  }

  /**
   * One process, one command list, one stdout — split back apart by marker.
   *
   * A spawned tmux writes every command's output to the same pipe, so the
   * sections need a boundary tmux itself prints. `display-message -p` between
   * the commands is that boundary: it costs one queue item, cannot fail on a
   * server that is answering, and its marker is random per group so no listing
   * can forge one.
   */
  async executeGroup(requests: readonly CommandRequest[]): Promise<readonly RawCommandResult[]> {
    const [first, ...rest] = requests;
    if (first === undefined) return Object.freeze([]);
    if (rest.length === 0) return Object.freeze([await this.execute(first)]);
    if (requests.some((request) => request.stdin !== undefined)) {
      throw new TmuxTransportError("a command list cannot carry stdin", {
        delivery: "not_started",
        kind: "protocol",
      });
    }

    const separator = createGroupSeparator();
    const args = assembleGroupArgv(requests, separator);
    const packed = packedArgvBytes([first.executable, ...args]);
    if (packed > MAX_PACKED_ARGV_BYTES) {
      // tmux would answer "command too long" from the client, with nothing to
      // say which command or by how much.
      throw new TmuxTransportError(
        `a command list of ${String(packed)} bytes exceeds the ${String(MAX_PACKED_ARGV_BYTES)} tmux packs an argv into`,
        { delivery: "not_started", kind: "protocol" },
      );
    }

    const result = await this.execute(
      snapshotCommandRequest({
        args: [...args],
        ...(first.environment === undefined ? {} : { environment: first.environment }),
        executable: first.executable,
        ...(first.signal === undefined ? {} : { signal: first.signal }),
        ...(first.timeoutMs === undefined ? {} : { timeoutMs: first.timeoutMs }),
      }),
    );

    const sections = splitOnMarker(result.stdout, `${separator}\n`);
    // A short list means tmux stopped at a failure: everything before it ran
    // and printed, and the section that stopped carries the exit status.
    return Object.freeze(
      sections.map((stdout, index) => ({
        cmd: Object.freeze([requests[index]?.executable ?? first.executable, ...args]),
        returncode: index === sections.length - 1 ? result.returncode : 0,
        signal: index === sections.length - 1 ? result.signal : null,
        stderr: index === sections.length - 1 ? result.stderr : new Uint8Array(),
        stdout,
      })),
    );
  }
}

/**
 * Split a byte stream on a marker line, keeping at most `sections` pieces.
 *
 * Byte-wise rather than by decoding: a pane title can carry any byte sequence,
 * and decoding to split would corrupt what the guarded frames then have to
 * parse.
 */
function splitOnMarker(bytes: Uint8Array, marker: string): readonly Uint8Array[] {
  const needle = new TextEncoder().encode(marker);
  const sections: Uint8Array[] = [];
  let start = 0;
  for (;;) {
    const at = indexOfBytes(bytes, needle, start);
    if (at < 0) {
      sections.push(bytes.subarray(start));
      return sections;
    }
    sections.push(bytes.subarray(start, at));
    start = at + needle.length;
  }
}

function indexOfBytes(source: Uint8Array, needle: Uint8Array, fromIndex: number): number {
  const lastStart = source.length - needle.length;
  for (let index = fromIndex; index <= lastStart; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (source[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}
