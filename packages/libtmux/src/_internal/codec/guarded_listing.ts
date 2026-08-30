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

/** Run several listings in one tmux command queue and decode each section in turn. */
export async function executeGuardedListGroup(
  options: GuardedExecutionOptions & { readonly listings: readonly GuardedListing[] },
): Promise<readonly (readonly ParsedFormatRow[])[]> {
  if (options.listings.length === 0) return Object.freeze([]);
  const capabilities = await options.capabilities.bind(options.signal);
  const prepared = options.listings.map((listing) => {
    const codec = new GuardCodec({ capabilities, listCommand: listing.listCommand });
    const request = codec.prepare();
    return {
      codec,
      command: [listing.listCommand, ...(listing.listExtraArgs ?? []), `-F${request.format}`],
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
        prepared.map(({ command }) => command),
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
  if (failure !== undefined) throw failure;
  const sections = demultiplexGuardedOutput(
    prepared.map(({ request }) => request),
    result.stdout,
  );
  return Object.freeze(
    prepared.map(({ codec, request }, index) => codec.decode(request, sections[index]!)),
  );
}
