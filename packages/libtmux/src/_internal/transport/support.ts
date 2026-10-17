import { basename } from "node:path";

import type { DaemonGuard } from "../../engine.js";
import {
  LibTmuxError,
  TmuxServerRestartedError,
  TmuxTransportError,
  VersionTooLowError,
} from "../../errors.js";
import { decodeBackslashReplace } from "../codec/backslash_replace.js";
import { parseTmuxVersion, type TmuxVersion } from "../runtime/tmux_version.js";
import { flattenInvocation } from "./invocation.js";
import { refusedUnknownCommand, uniqueUnknownCommand } from "./refusal.js";
import { snapshotInvocationRequest } from "./types.js";
import type { CommandRequest, CommandTransport, RawCommandResult } from "./types.js";

/** The oldest tmux whose daemon this package drives for ordinary operations. */
const MINIMUM_TMUX = "3.3a";

/**
 * Where a report sits among the forms tmux has ever printed, or `undefined`.
 *
 * `next-X.Y` precedes `X.Y-rc`, `X.Y-rcN`, `X.Y` and `X.Ya`, minors compare as
 * numbers, and nothing else parses: not bare `master`, `openbsd-*`, a patch
 * letter on a development build, or a `-master` or `-dev` suffix.
 */
function releaseRank(raw: string): readonly number[] | undefined {
  const next = /^next-(\d+)\.(\d+)$/u.exec(raw);
  if (next !== null) return [Number(next[1]), Number(next[2]), 0, 0];
  const release = /^(\d+)\.(\d+)(?:([a-z])|-rc(\d*))?$/u.exec(raw);
  if (release === null) return undefined;
  const [, major, minor, letter, candidate] = release;
  if (letter !== undefined) return [Number(major), Number(minor), 2, letter.charCodeAt(0) - 96];
  if (candidate !== undefined) return [Number(major), Number(minor), 1, Number(candidate || 0)];
  return [Number(major), Number(minor), 2, 0];
}

/** Whether a report ranks at or above `minimum`; an unparseable report never does. */
export function releaseAtLeast(raw: string, minimum: string): boolean {
  const have = releaseRank(raw);
  const want = releaseRank(minimum);
  if (have === undefined || want === undefined) return false;
  for (const [index, wanted] of want.entries()) {
    if (have[index]! !== wanted) return have[index]! > wanted;
  }
  return true;
}

/**
 * Admit a version report for ordinary operations, or refuse it.
 *
 * Patch letters count, so `3.3` is below `3.3a`, and a candidate or
 * development build ranks below the release it names, so `3.3-rc` and
 * `next-3.3` are refused while `3.4-rc` and `next-3.4` are admitted.
 */
export function requireCoreVersion(raw: string): TmuxVersion {
  if (!releaseAtLeast(raw, MINIMUM_TMUX)) {
    throw new VersionTooLowError({
      criteriaName: "core operations",
      delivery: "not_started",
      serverVersion: raw,
      since: MINIMUM_TMUX,
    });
  }
  return parseTmuxVersion(raw);
}

/** The commands carrying `CMD_STARTSERVER`; a prefix counts, since tmux resolves one. */
const STARTS_SERVER: readonly (readonly [canonical: string, alias?: string])[] = [
  ["new-session", "new"],
  ["start-server", "start"],
  ["attach-session", "attach"],
  ["list-keys", "lsk"],
  ["list-commands", "lscm"],
];

function startsServer(name: string): boolean {
  return STARTS_SERVER.some(
    ([canonical, alias]) => name === alias || (name !== "" && canonical.startsWith(name)),
  );
}

function commandsStartServer(commands: CommandRequest["commands"]): boolean {
  return commands.some(([name]) => startsServer(name));
}

/** Whether the client answers this itself, without contacting any daemon. */
function isDiagnostic(globalArgs: readonly string[]): boolean {
  return globalArgs.some((argument) => argument === "-V" || argument === "-h");
}

/** What the version probe reports about a live daemon. */
export interface DaemonReading {
  readonly daemon: DaemonGuard;
  readonly rawVersion: string;
}

/** The probe's answer: a daemon, or the failure that proves there is none. */
export type ProbeOutcome =
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "daemon"; readonly reading: DaemonReading };

/**
 * The endpoint a request addresses, without the commands it carries.
 *
 * Everything a probe needs to reach the same daemon the request would.
 */
export type EndpointRequest = Pick<
  CommandRequest,
  "environment" | "executable" | "globalArgs" | "signal" | "timeoutMs"
>;

function endpointFields(endpoint: EndpointRequest): Partial<CommandRequest> {
  return {
    ...(endpoint.environment === undefined ? {} : { environment: endpoint.environment }),
    ...(endpoint.signal === undefined ? {} : { signal: endpoint.signal }),
    ...(endpoint.timeoutMs === undefined ? {} : { timeoutMs: endpoint.timeoutMs }),
  };
}

/**
 * The request that reads a daemon's version and identity without firing a hook.
 *
 * `run-shell -C` expands the format, then parses it as a command after the
 * command itself has returned, so no `after-*` or `command-error` hook fires.
 * tmux refuses the unknown command and names the expansion on stderr; `-N`
 * keeps the probe from starting a server.
 */
export function daemonProbe(endpoint: EndpointRequest): {
  readonly marker: string;
  readonly request: CommandRequest;
} {
  const marker = `${uniqueUnknownCommand("version")}-`;
  const request = snapshotInvocationRequest({
    commands: [["run-shell", "-C", `${marker}#{version}/#{pid}/#{start_time}`]],
    executable: endpoint.executable,
    globalArgs: [...endpoint.globalArgs, "-N"],
    ...endpointFields(endpoint),
  });
  return { marker, request };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** The server was not running, or its socket was not there to connect to. */
function absentEndpoint(stderr: string): boolean {
  return (
    /^no server running on [^\r\n]+$/u.test(stderr) ||
    /^error connecting to [^\r\n]+ \((?:No such file or directory|Connection refused)\)$/u.test(
      stderr,
    )
  );
}

/** Read a daemon's identity from the probe's refusal, or say there is no daemon. */
export function interpretProbe(result: RawCommandResult, marker: string): ProbeOutcome {
  const stderr = decodeBackslashReplace(result.stderr).trimEnd();
  const reported = new RegExp(
    `^unknown command: ${escapeRegExp(marker)}(?<version>[^/\\s]+)/(?<pid>[1-9]\\d*)/(?<start>[1-9]\\d*)$`,
    "u",
  ).exec(stderr);
  if (result.exitCode === 1 && result.signal === null && reported?.groups !== undefined) {
    const { pid, start, version } = reported.groups;
    return {
      kind: "daemon",
      reading: { daemon: { pid: pid!, startTime: start! }, rawVersion: version! },
    };
  }
  if (result.exitCode !== 0 && absentEndpoint(stderr)) return { kind: "absent", reason: stderr };
  throw new LibTmuxError(
    stderr === ""
      ? `cannot reach tmux: it exited with status ${String(result.exitCode)}`
      : `cannot reach tmux: ${stderr}`,
  );
}

/** Read a live daemon afresh and refuse one below the floor; an absent endpoint is an error. */
export async function admitDaemon(
  transport: CommandTransport,
  endpoint: EndpointRequest,
): Promise<DaemonReading> {
  const { marker, request } = daemonProbe(endpoint);
  const outcome = interpretProbe(await transport.execute(request), marker);
  if (outcome.kind === "absent") throw new LibTmuxError(`cannot reach tmux: ${outcome.reason}`);
  requireCoreVersion(outcome.reading.rawVersion);
  return outcome.reading;
}

/** Read the version a client reports; 3.3a prints its executable's name in place of `tmux`. */
export function executableVersion(result: RawCommandResult, executable: string): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(result.stdout);
  const name = basename(executable);
  const prefix = [`${name} `, "tmux "].find((candidate) => text.startsWith(candidate));
  const version = prefix === undefined ? undefined : text.slice(prefix.length).trimEnd();
  if (result.exitCode !== 0 || version === undefined || version === "" || /\s/u.test(version)) {
    throw new LibTmuxError("cannot establish the version of the configured tmux executable");
  }
  return version;
}

/** The request that makes the client print its own version and exit. */
export function executableProbe(endpoint: EndpointRequest): CommandRequest {
  return snapshotInvocationRequest({
    commands: [["display-message", "-p", "#{version}"]],
    executable: endpoint.executable,
    globalArgs: ["-V"],
    ...endpointFields(endpoint),
  });
}

/** The identity of one endpoint, as far as which daemon it reaches is concerned. */
function endpointKey(request: CommandRequest): string {
  return JSON.stringify([request.executable, request.globalArgs.filter((flag) => flag !== "-N")]);
}

const PROBE_PREFIX = /^libtmux-version-[0-9a-f]{32}-#\{version\}\/#\{pid\}\/#\{start_time\}$/u;

/** The marker of {@link daemonProbe}'s request, which establishes admission rather than needing it. */
function isDaemonProbe(request: CommandRequest): string | undefined {
  const [command] = request.commands;
  const [name, flag, format] = command;
  if (request.commands.length !== 1 || name !== "run-shell" || flag !== "-C") return undefined;
  if (command.length !== 3 || format === undefined || !PROBE_PREFIX.test(format)) return undefined;
  return format.slice(0, format.indexOf("#"));
}

function unavailable(request: CommandRequest, error: TmuxTransportError): TmuxTransportError {
  return new TmuxTransportError(error.message, {
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    delivery: "not_started",
    kind: error.kind,
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    stderr: error.stderr,
    stdout: error.stdout,
    subcommand: request.commands[0][0],
  });
}

/**
 * Admit each invocation against the daemon that will run it, before it runs.
 *
 * The daemon's version is read once per endpoint, and every invocation then
 * carries a fence tmux evaluates in its own command queue: a daemon of another
 * release makes the fence name an unknown command and the list never runs.
 * Live endpoints get `-N`. At an absent endpoint a command that cannot start a
 * server gets the failure the probe saw; one that can runs only after the
 * client executable reports a supported release. `-V` and `-h` pass through.
 */
export class AdmissionTransport implements CommandTransport {
  readonly #admitted = new Map<string, string>();
  readonly #inner: CommandTransport;

  constructor(inner: CommandTransport) {
    this.#inner = inner;
  }

  /** Pass a probe through, keeping a supported answer for the commands after it. */
  async #relayProbe(request: CommandRequest, marker: string): Promise<RawCommandResult> {
    const result = await this.#inner.execute(request);
    try {
      const outcome = interpretProbe(result, marker);
      if (outcome.kind === "daemon") {
        requireCoreVersion(outcome.reading.rawVersion);
        this.#admitted.set(endpointKey(request), outcome.reading.rawVersion);
      }
    } catch {
      // The caller that asked for the probe reports what it could not read.
    }
    return result;
  }

  async execute(input: CommandRequest): Promise<RawCommandResult> {
    const request = snapshotInvocationRequest(input);
    if (isDiagnostic(request.globalArgs)) return this.#inner.execute(request);
    const probing = isDaemonProbe(request);
    if (probing !== undefined) return this.#relayProbe(request, probing);
    const deadline =
      request.timeoutMs === undefined ? undefined : performance.now() + request.timeoutMs;
    let spent = false;
    const budget = (): { readonly timeoutMs?: number } => {
      if (request.signal?.aborted === true) {
        throw new TmuxTransportError("command cancelled during tmux admission", {
          ...(request.signal.reason === undefined ? {} : { cause: request.signal.reason }),
          delivery: "not_started",
          kind: "cancelled",
          subcommand: request.commands[0][0],
        });
      }
      if (deadline === undefined || !spent)
        return request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs };
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) {
        throw new TmuxTransportError("command timed out during tmux admission", {
          delivery: "not_started",
          kind: "timeout",
          subcommand: request.commands[0][0],
        });
      }
      return { timeoutMs: remaining };
    };
    const ask = async (probe: CommandRequest): Promise<RawCommandResult> => {
      try {
        return await this.#inner.execute(probe);
      } catch (error) {
        throw error instanceof TmuxTransportError ? unavailable(request, error) : error;
      }
    };

    const key = endpointKey(request);
    const starts = commandsStartServer(request.commands);
    let version = starts ? undefined : this.#admitted.get(key);
    let live = version !== undefined;
    if (version === undefined) {
      const { marker, request: probe } = daemonProbe({ ...request, ...budget() });
      spent = true;
      const outcome = interpretProbe(await ask(probe), marker);
      if (outcome.kind === "daemon") {
        requireCoreVersion(outcome.reading.rawVersion);
        version = outcome.reading.rawVersion;
        live = true;
        this.#admitted.set(key, version);
      } else if (!starts) {
        // No daemon is listening and this command cannot start one. The
        // failure it would report is the probe's own.
        return {
          cmd: Object.freeze([request.executable, ...flattenInvocation(request)]),
          exitCode: 1,
          signal: null,
          stderr: new TextEncoder().encode(`${outcome.reason}\n`),
          stdout: new Uint8Array(),
        };
      } else {
        const own = await ask(executableProbe({ ...request, ...budget() }));
        version = executableVersion(own, request.executable);
        requireCoreVersion(version);
      }
    }

    const refusal = uniqueUnknownCommand("version");
    const condition = `#{==:#{version},${version}}`;
    const fenced = snapshotInvocationRequest({
      ...request,
      commands: [["if-shell", "-F", condition, "", refusal], ...request.commands],
      globalArgs: live ? [...request.globalArgs, "-N"] : request.globalArgs,
      ...budget(),
    });
    const result = await this.#inner.execute(fenced);
    if (refusedUnknownCommand(refusal, result.exitCode, result.stderr)) {
      this.#admitted.delete(key);
      throw new TmuxServerRestartedError(
        "tmux changed after admission; the requested operation did not run",
        { subcommand: request.commands[0][0] },
      );
    }
    return { ...result, cmd: Object.freeze([request.executable, ...flattenInvocation(request)]) };
  }
}
