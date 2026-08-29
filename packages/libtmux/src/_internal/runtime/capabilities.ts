import { createHash } from "node:crypto";

import type { ConnectionAlias, DaemonEpoch } from "../../common.js";
import type { DaemonGuard } from "../../engine.js";
import { LibTmuxException, TmuxTransportError } from "../../exc.js";
import type { AbortLike } from "../../types.js";
import { decodeBackslashReplace } from "../codec/backslash_replace.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "../transport/types.js";
import { snapshotInvocationRequest } from "../transport/types.js";
import type { TmuxConnection } from "./connection.js";
import { parseTmuxVersion, tmuxVersionIsExact, type TmuxVersion } from "./tmux_version.js";

export interface TmuxCapabilities {
  readonly connectionAlias: ConnectionAlias;
  readonly daemon: DaemonGuard;
  readonly daemonEpoch: DaemonEpoch;
  readonly fingerprint: string;
  readonly quirks: Readonly<{
    breakPane37: boolean;
  }>;
  readonly rawVersion: string;
  readonly tmuxVersion: TmuxVersion;
}

export interface CapabilityBinding {
  bind(signal?: AbortLike): Promise<TmuxCapabilities>;
}

export interface DeriveTmuxCapabilitiesOptions {
  readonly connectionAlias: ConnectionAlias;
  readonly daemon: DaemonGuard;
  readonly daemonEpoch: DaemonEpoch;
  readonly rawVersion: string;
}

export interface LazyCapabilityBindingOptions {
  readonly timeoutMs?: number;
  readonly connection: TmuxConnection;
  readonly connectionAlias: ConnectionAlias;
  readonly getDaemonEpoch: () => DaemonEpoch;
  readonly transport: CommandTransport;
}

interface InFlightCapabilityProbe {
  readonly abort: AbortController;
  readonly daemonEpoch: DaemonEpoch;
  readonly promise: Promise<TmuxCapabilities>;
  waiters: number;
}

function capabilityFingerprint(options: DeriveTmuxCapabilitiesOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        options.connectionAlias,
        options.daemonEpoch,
        options.daemon.pid,
        options.daemon.startTime,
        options.rawVersion,
      ]),
    )
    .digest("hex");
}

export function deriveTmuxCapabilities(options: DeriveTmuxCapabilitiesOptions): TmuxCapabilities {
  const tmuxVersion = parseTmuxVersion(options.rawVersion);
  const quirks = Object.freeze({
    breakPane37: tmuxVersionIsExact(tmuxVersion, parseTmuxVersion("3.7")),
  });
  return Object.freeze({
    connectionAlias: options.connectionAlias,
    daemon: Object.freeze({ pid: options.daemon.pid, startTime: options.daemon.startTime }),
    daemonEpoch: options.daemonEpoch,
    fingerprint: capabilityFingerprint(options),
    quirks,
    rawVersion: options.rawVersion,
    tmuxVersion,
  });
}

export class LazyCapabilityBinding implements CapabilityBinding {
  readonly #connection: TmuxConnection;
  readonly #connectionAlias: ConnectionAlias;
  readonly #getDaemonEpoch: () => DaemonEpoch;
  readonly #transport: CommandTransport;
  readonly #timeoutMs: number | undefined;
  #cached: TmuxCapabilities | undefined;
  #inFlight: InFlightCapabilityProbe | undefined;

  constructor(options: LazyCapabilityBindingOptions) {
    this.#connection = options.connection;
    this.#connectionAlias = options.connectionAlias;
    this.#getDaemonEpoch = options.getDaemonEpoch;
    this.#transport = options.transport;
    this.#timeoutMs = options.timeoutMs;
  }

  async bind(signal?: AbortLike): Promise<TmuxCapabilities> {
    if (signal?.aborted === true) throw this.#cancelled("not_started");
    const daemonEpoch = this.#getDaemonEpoch();
    if (this.#cached?.daemonEpoch === daemonEpoch) return this.#cached;
    let inFlight = this.#inFlight;
    if (
      inFlight === undefined ||
      inFlight.daemonEpoch !== daemonEpoch ||
      inFlight.abort.signal.aborted
    ) {
      inFlight = this.#startProbe(daemonEpoch);
    }
    return this.#joinProbe(inFlight, signal);
  }

  #cancelled(delivery: "indeterminate" | "not_started"): TmuxTransportError {
    return new TmuxTransportError("capability binding cancelled", {
      delivery,
      kind: "cancelled",
      subcommand: "display-message",
    });
  }

  async #joinProbe(
    inFlight: InFlightCapabilityProbe,
    signal: AbortLike | undefined,
  ): Promise<TmuxCapabilities> {
    inFlight.waiters += 1;
    let callerAborted = false;
    const joined =
      signal === undefined
        ? inFlight.promise
        : new Promise<TmuxCapabilities>((resolve, reject) => {
            const onAbort = (): void => {
              callerAborted = true;
              signal.removeEventListener("abort", onAbort);
              if (inFlight.waiters === 1) inFlight.abort.abort();
              reject(this.#cancelled("indeterminate"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
              return;
            }
            void inFlight.promise.then(
              (capabilities) => {
                signal.removeEventListener("abort", onAbort);
                resolve(capabilities);
              },
              (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
          });
    try {
      return await joined;
    } finally {
      inFlight.waiters -= 1;
      if (callerAborted && inFlight.waiters === 0) {
        inFlight.abort.abort();
        await inFlight.promise.catch(() => undefined);
      }
    }
  }

  #request(signal: AbortLike): CommandRequest {
    const args = ["-N"];
    if (this.#connection.colors === 256) args.push("-2");
    if (this.#connection.colors === 88) args.push("-8");
    if (this.#connection.configFile !== undefined) args.push(`-f${this.#connection.configFile}`);
    if (this.#connection.socketName !== undefined) args.push(`-L${this.#connection.socketName}`);
    if (this.#connection.socketPath !== undefined) args.push(`-S${this.#connection.socketPath}`);
    return snapshotInvocationRequest({
      commands: [["display-message", "-p", "#{version}\t#{pid}\t#{start_time}"]],
      environment: this.#connection.environment,
      executable: this.#connection.executable,
      globalArgs: args,
      signal,
      // The probe is the first command a server runs, so an unbounded one
      // hangs every caller before any of their own deadlines apply.
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
  }

  async #probe(daemonEpoch: DaemonEpoch, signal: AbortLike): Promise<TmuxCapabilities> {
    let result: RawCommandResult;
    try {
      result = await this.#transport.execute(this.#request(signal));
    } catch (error) {
      if (error instanceof TmuxTransportError && error.kind === "cancelled") throw error;
      const detail = error instanceof Error && error.message !== "" ? `: ${error.message}` : "";
      throw new LibTmuxException(`cannot reach tmux${detail}`, {
        cause: error,
        subcommand: "display-message",
      });
    }

    if (result.returncode !== 0) {
      const stderr = decodeBackslashReplace(result.stderr).trimEnd();
      throw new LibTmuxException(
        stderr === ""
          ? `cannot reach tmux: it exited with status ${result.returncode}`
          : `cannot reach tmux: ${stderr}`,
        { subcommand: "display-message" },
      );
    }

    const replies = decodeBackslashReplace(result.stdout).split("\n");
    while (replies.at(-1) === "") replies.pop();
    if (replies.length === 0) {
      throw new LibTmuxException("tmux version probe returned no version", {
        subcommand: "display-message",
      });
    }
    if (replies.length !== 1) {
      throw new LibTmuxException("tmux version probe returned multiple versions", {
        subcommand: "display-message",
      });
    }
    const [rawVersion, pid, startTime, extra] = replies[0]!.split("\t");
    if (
      rawVersion === undefined ||
      pid === undefined ||
      startTime === undefined ||
      extra !== undefined ||
      !/^[1-9]\d*$/u.test(pid) ||
      !/^[1-9]\d*$/u.test(startTime)
    ) {
      throw new LibTmuxException("tmux capability probe returned an invalid daemon identity", {
        subcommand: "display-message",
      });
    }

    let capabilities: TmuxCapabilities;
    try {
      capabilities = deriveTmuxCapabilities({
        connectionAlias: this.#connectionAlias,
        daemon: { pid, startTime },
        daemonEpoch,
        rawVersion,
      });
    } catch (error) {
      throw new LibTmuxException(error instanceof Error ? error.message : "invalid tmux version", {
        cause: error,
        subcommand: "display-message",
      });
    }
    if (this.#getDaemonEpoch() !== daemonEpoch) {
      throw new LibTmuxException("daemon epoch changed while binding capabilities", {
        subcommand: "display-message",
      });
    }
    return capabilities;
  }

  #startProbe(daemonEpoch: DaemonEpoch): InFlightCapabilityProbe {
    const abort = new AbortController();
    let inFlight!: InFlightCapabilityProbe;
    const promise = this.#probe(daemonEpoch, abort.signal)
      .then((capabilities) => {
        if (
          this.#inFlight === inFlight &&
          !abort.signal.aborted &&
          this.#getDaemonEpoch() === daemonEpoch
        ) {
          this.#cached = capabilities;
        }
        return capabilities;
      })
      .finally(() => {
        if (this.#inFlight === inFlight) this.#inFlight = undefined;
      });
    inFlight = { abort, daemonEpoch, promise, waiters: 0 };
    this.#inFlight = inFlight;
    return inFlight;
  }
}
