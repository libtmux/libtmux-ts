import { LibTmuxException } from "../../exc.js";
import type { AbortLike } from "../../types.js";
import { prepareCommandRequest, prepareInvocationRequest } from "../operations/request.js";
import type { TmuxConnection } from "../runtime/connection.js";
import {
  TmuxTransportError,
  type CommandTransport,
  type RawCommandResult,
} from "../transport/types.js";
import { decodeBackslashReplace } from "./backslash_replace.js";
import type { ListCommand, ParsedFormatRow } from "./format_types.js";
import {
  demultiplexGuardedOutput,
  FormatProtocolError,
  GuardCodec,
  type GuardCodecCapabilities,
} from "./guard_codec.js";

export interface GuardCodecCapabilityBinding {
  bind(signal?: AbortLike): Promise<GuardCodecCapabilities>;
}

interface GuardedExecutionOptions {
  readonly capabilities: GuardCodecCapabilityBinding;
  readonly connection: TmuxConnection;
  readonly signal?: AbortLike;
  readonly timeoutMs?: number;
  readonly transport: CommandTransport;
}

export interface GuardedListing {
  readonly listCommand: ListCommand;
  readonly listExtraArgs?: readonly string[];
}

export type GuardedListOptions = GuardedExecutionOptions & GuardedListing;

export interface GuardedListGroupResult {
  readonly daemon: Readonly<{ pid: string; start_time: string }>;
  readonly listings: readonly (readonly ParsedFormatRow[])[];
}

const IDENTITY_FORMAT = "ltxI#{pid};#{start_time}";

function decodedStderr(bytes: Uint8Array): string {
  return decodeBackslashReplace(bytes).trimEnd();
}

function commandFailure(
  listCommand: ListCommand | undefined,
  result: RawCommandResult,
): LibTmuxException | undefined {
  const stderr = decodedStderr(result.stderr);
  if (result.returncode === 0 && result.signal === null && stderr === "") return undefined;
  const message =
    stderr !== ""
      ? stderr
      : result.signal === null
        ? `tmux command failed with status ${result.returncode}`
        : `tmux command failed with signal ${result.signal}`;
  return new LibTmuxException(
    message,
    listCommand === undefined ? {} : { subcommand: listCommand },
  );
}

function transportFailure(
  listCommand: ListCommand | undefined,
  error: TmuxTransportError,
): TmuxTransportError {
  const stderr = decodedStderr(error.stderr);
  return new TmuxTransportError(stderr === "" ? error.message : stderr, {
    cause: error,
    delivery: error.delivery,
    kind: error.kind,
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    stderr: error.stderr,
    stdout: error.stdout,
    ...(listCommand === undefined ? {} : { subcommand: listCommand }),
  });
}

export async function executeGuardedList(
  options: GuardedListOptions,
): Promise<readonly ParsedFormatRow[]> {
  const listExtraArgs: readonly string[] = Object.freeze([...(options.listExtraArgs ?? [])]);
  const capabilities = await options.capabilities.bind(options.signal);
  const codec = new GuardCodec({ capabilities, listCommand: options.listCommand });
  const guardedRequest = codec.prepare();
  const commandRequest = prepareCommandRequest(
    options.connection,
    [options.listCommand, ...listExtraArgs, `-F${guardedRequest.format}`],
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  );
  const currentCapabilities = await options.capabilities.bind(options.signal);
  if (currentCapabilities.fingerprint !== guardedRequest.capabilityFingerprint) {
    throw new FormatProtocolError("capability fingerprint changed before execution");
  }

  let result: RawCommandResult;
  try {
    result = await options.transport.execute(commandRequest);
  } catch (error) {
    if (!(error instanceof TmuxTransportError)) throw error;
    throw transportFailure(options.listCommand, error);
  }
  const failure = commandFailure(options.listCommand, result);
  if (failure !== undefined) throw failure;
  return codec.decode(guardedRequest, result.stdout);
}

function splitIdentityFrame(bytes: Uint8Array): {
  readonly daemon: Readonly<{ pid: string; start_time: string }>;
  readonly listings: Uint8Array;
} {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) throw new FormatProtocolError("daemon identity frame is incomplete");
  let frame: string;
  try {
    frame = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, newline));
  } catch (error) {
    throw new FormatProtocolError("daemon identity frame is not UTF-8", { cause: error });
  }
  const match = /^ltxI(?<pid>[1-9]\d*);(?<startTime>\d+)$/u.exec(frame);
  const pid = match?.groups?.["pid"];
  const start_time = match?.groups?.["startTime"];
  if (pid === undefined || start_time === undefined) {
    throw new FormatProtocolError("daemon identity frame is invalid");
  }
  return {
    daemon: Object.freeze({ pid, start_time }),
    listings: bytes.slice(newline + 1),
  };
}

/** Run listings and an always-emitting daemon identity in one tmux command queue. */
export async function executeGuardedListGroup(
  options: GuardedExecutionOptions & { readonly listings: readonly GuardedListing[] },
): Promise<GuardedListGroupResult> {
  const capabilities = await options.capabilities.bind(options.signal);
  const prepared = options.listings.map((listing) => {
    const codec = new GuardCodec({ capabilities, listCommand: listing.listCommand });
    const request = codec.prepare();
    return {
      codec,
      command: [listing.listCommand, ...(listing.listExtraArgs ?? []), `-F${request.format}`],
      listing,
      request,
    };
  });

  const current = await options.capabilities.bind(options.signal);
  if (prepared.some(({ request }) => current.fingerprint !== request.capabilityFingerprint)) {
    throw new FormatProtocolError("capability fingerprint changed before execution");
  }

  let result: RawCommandResult;
  try {
    result = await options.transport.execute(
      prepareInvocationRequest(
        options.connection,
        [["display-message", "-p", IDENTITY_FORMAT], ...prepared.map(({ command }) => command)],
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      ),
    );
  } catch (error) {
    if (!(error instanceof TmuxTransportError)) throw error;
    throw transportFailure(undefined, error);
  }

  const failure = commandFailure(undefined, result);
  const expectedEmptyFailure =
    failure !== undefined &&
    result.returncode === 1 &&
    result.signal === null &&
    decodedStderr(result.stderr) === "no current target" &&
    prepared[0]?.listing.listCommand === "list-sessions";
  if (failure !== undefined && !expectedEmptyFailure) throw failure;

  const captured = splitIdentityFrame(result.stdout);
  const sections = demultiplexGuardedOutput(
    prepared.map(({ request }) => request),
    captured.listings,
  );
  const decoded = Object.freeze({
    daemon: captured.daemon,
    listings: Object.freeze(
      prepared.map(({ codec, request }, index) => codec.decode(request, sections[index]!)),
    ),
  });
  if (failure === undefined) return decoded;

  // `list-sessions` ran earlier in this queue, so its empty section plus this
  // exact tmux diagnostic proves no target-scoped row can exist.
  if (decoded.listings.every((rows) => rows.length === 0)) {
    return decoded;
  }
  throw failure;
}
