import { createHash } from "node:crypto";

import type { ConnectionAlias, DaemonEpoch } from "../../common.js";
import type { DaemonGuard } from "../../engine.js";
import { LibTmuxError, TmuxTransportError } from "../../errors.js";
import type { AbortLike } from "../../types.js";
import {
  daemonProbe,
  interpretProbe,
  probeFailure,
  requireCoreVersion,
} from "../support/versions.js";
import type { CommandTransport, RawCommandResult } from "../transport/types.js";
import type { TmuxConnection } from "./connection.js";
import { parseTmuxVersion, type TmuxVersion } from "./tmux_version.js";

export interface TmuxCapabilities {
  readonly connectionAlias: ConnectionAlias;
  readonly daemon: DaemonGuard;
  readonly daemonEpoch: DaemonEpoch;
  readonly fingerprint: string;
  readonly rawVersion: string;
  readonly tmuxVersion: TmuxVersion;
}

interface CapabilityBinding {
  bind(signal?: AbortLike): Promise<TmuxCapabilities>;
  /** What `bind` would answer without a command, or nothing. */
  bound(): TmuxCapabilities | undefined;
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
  return Object.freeze({
    connectionAlias: options.connectionAlias,
    daemon: Object.freeze({ pid: options.daemon.pid, startTime: options.daemon.startTime }),
    daemonEpoch: options.daemonEpoch,
    fingerprint: capabilityFingerprint(options),
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

  bound(): TmuxCapabilities | undefined {
    return this.#cached?.daemonEpoch === this.#getDaemonEpoch() ? this.#cached : undefined;
  }

  async bind(signal?: AbortLike): Promise<TmuxCapabilities> {
    if (signal?.aborted === true) throw this.#cancelled("not_started");
    const bound = this.bound();
    if (bound !== undefined) return bound;
    const daemonEpoch = this.#getDaemonEpoch();
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
      subcommand: "run-shell",
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

  async #probe(daemonEpoch: DaemonEpoch, signal: AbortLike): Promise<TmuxCapabilities> {
    const args = [];
    if (this.#connection.colors === 256) args.push("-2");
    if (this.#connection.configFile !== undefined) args.push(`-f${this.#connection.configFile}`);
    if (this.#connection.socketName !== undefined) args.push(`-L${this.#connection.socketName}`);
    if (this.#connection.socketPath !== undefined) args.push(`-S${this.#connection.socketPath}`);
    const { marker, request } = daemonProbe({
      environment: this.#connection.environment,
      executable: this.#connection.executable,
      globalArgs: args,
      signal,
      // The probe is the first command a server runs, so an unbounded one
      // hangs every caller before any of their own deadlines apply.
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
    let result: RawCommandResult;
    try {
      result = await this.#transport.execute(request);
    } catch (error) {
      if (error instanceof TmuxTransportError && error.kind === "cancelled") throw error;
      const detail = error instanceof Error && error.message !== "" ? `: ${error.message}` : "";
      throw probeFailure(detail.replace(/^: /u, ""), {
        cause: error,
        ...(error instanceof TmuxTransportError ? { kind: error.kind } : {}),
      });
    }

    const outcome = interpretProbe(result, marker);
    if (outcome.kind === "absent") {
      throw probeFailure(outcome.reason);
    }
    const { daemon, rawVersion } = outcome.reading;
    requireCoreVersion(rawVersion);

    let capabilities: TmuxCapabilities;
    try {
      capabilities = deriveTmuxCapabilities({
        connectionAlias: this.#connectionAlias,
        daemon,
        daemonEpoch,
        rawVersion,
      });
    } catch (error) {
      throw new LibTmuxError(error instanceof Error ? error.message : "invalid tmux version", {
        cause: error,
        subcommand: "run-shell",
      });
    }
    if (this.#getDaemonEpoch() !== daemonEpoch) {
      throw new LibTmuxError("daemon epoch changed while binding capabilities", {
        subcommand: "run-shell",
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
