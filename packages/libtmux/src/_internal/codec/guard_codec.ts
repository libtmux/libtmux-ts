import { randomUUID } from "node:crypto";

import { FORMAT_FIELD_TOKENS } from "../../_generated/format_fields.js";
import { LibTmuxException, TmuxObjectDoesNotExist } from "../../exc.js";
import type { FormatFieldName } from "../../_generated/format_field_names.js";
import { ParsedFormatRow, type ListCommand, type OutputFormatField } from "./format_types.js";
import { prepareCommandRequest, prepareInvocationRequest } from "../operations/request.js";
import type { TmuxConnection } from "../runtime/connection.js";
import type { CapabilityBinding, TmuxCapabilities } from "../runtime/capabilities.js";
import type { TmuxVersion } from "../runtime/tmux_version.js";
import {
  TmuxTransportError,
  type CommandTransport,
  type RawCommandResult,
} from "../transport/types.js";
import { decodeBackslashReplace } from "./backslash_replace.js";
import { formatFieldsForListCommand } from "./format_registry.js";
import {
  parseCompleteFormatRow,
  parseFormatIdentity,
  type CompleteFormatRow,
  type RawCompleteFormatRow,
} from "./schemas.js";

export interface FormatGuards {
  readonly field: string;
  readonly recordEnd: string;
  readonly recordStart: string;
}

export type GuardFactory = () => FormatGuards;

export interface GuardedFormatRequest {
  readonly capabilityFingerprint: string;
  readonly fields: readonly OutputFormatField[];
  readonly format: string;
  readonly guards: FormatGuards;
  readonly listCommand: ListCommand;
  readonly tmuxVersion: TmuxVersion;
}

export interface GuardCodecOptions {
  readonly capabilities: TmuxCapabilities;
  readonly guardFactory?: GuardFactory;
  readonly listCommand: ListCommand;
}

export class FormatProtocolError extends LibTmuxException {}

/**
 * Describe a response that did not frame, without printing it.
 *
 * A framing failure says the bytes are not what the guards say they should be,
 * and the interesting question is which way: too few guards means the response
 * was cut short, an unexpected one means it carries something that was not
 * asked for. Neither is answerable from the message alone, and the response can
 * hold pane titles and paths — so this reports the shape and not the contents.
 */
function framingEvidence(bytes: Uint8Array, guards: FormatGuards, offset: number): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const occurrences = (needle: string): number => text.split(needle).length - 1;
  return (
    ` (${String(bytes.length)} bytes, ${String(occurrences(guards.recordStart))} record starts, ` +
    `${String(occurrences(guards.recordEnd))} record ends, ` +
    `${String(occurrences(guards.field))} field separators, failed at ${String(offset)})`
  );
}

/**
 * How a row's fields are told apart, and why it costs one byte.
 *
 * Every value is requested through `#{q:…}`, which is tmux's own shell quoting:
 * `format_quote_shell` backslash-escapes ``|&;<>()$`\\"'*?[# =%`` — including the
 * backslash — so a semicolon inside a pane title arrives as `\;` and a bare one
 * can only be the separator. Guaranteed, where a random guard is merely
 * improbable, and one byte where a guard is dozens: four listings have to fit in
 * the 16KB tmux packs an argv into, and 569 separators is what decides whether
 * they do.
 */
const FIELD_SEPARATOR = ";";

/** The set `format_quote_shell` escapes, which is what a separator has to come from. */
const QUOTED_BY_TMUX = "|&;<>()$`\\\"'*?[# =%";

/**
 * Record guards stay random, at 96 bits.
 *
 * Quoting does not help here: a value carrying the guard's own hex would emit it
 * unescaped, because hex needs no escaping. Randomness is what makes that
 * impossible in practice, and a collision splits or merges rows rather than
 * mis-cutting one, so it is the delimiter worth paying for.
 */
const RECORD_GUARD_HEX = 24;

function randomHex(length: number): string {
  return randomUUID().replaceAll("-", "").slice(0, length);
}

function defaultGuardFactory(): FormatGuards {
  return Object.freeze({
    field: FIELD_SEPARATOR,
    recordEnd: `ltxE${randomHex(RECORD_GUARD_HEX)}`,
    recordStart: `ltxS${randomHex(RECORD_GUARD_HEX)}`,
  });
}

function snapshotGuards(guards: FormatGuards): FormatGuards {
  const snapshot = Object.freeze({
    field: guards.field,
    recordEnd: guards.recordEnd,
    recordStart: guards.recordStart,
  });
  const values = [snapshot.field, snapshot.recordEnd, snapshot.recordStart];
  // One byte, and one tmux escapes: the split reads bytes and decides a
  // boundary by the backslashes before it, which only works for a separator
  // `#{q:…}` is guaranteed to escape inside a value.
  if (snapshot.field.length !== 1 || !QUOTED_BY_TMUX.includes(snapshot.field)) {
    throw new FormatProtocolError("field separator must be one character tmux escapes");
  }
  if (
    values.some((value) => typeof value !== "string" || !/^[\x20-\x7e]+$/u.test(value)) ||
    new Set(values).size !== values.length ||
    values.some((value, index) =>
      values.some((other, otherIndex) => index !== otherIndex && other.includes(value)),
    )
  ) {
    throw new FormatProtocolError("guard values must be distinct nonempty printable ASCII");
  }
  return snapshot;
}

function snapshotVersion(version: TmuxVersion): TmuxVersion {
  return Object.freeze({
    major: version.major,
    minor: version.minor,
    raw: version.raw,
    suffix: version.suffix,
  });
}

function bytesFor(value: string): Uint8Array {
  return new TextEncoder().encode(value);
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

function bytesAt(source: Uint8Array, needle: Uint8Array, index: number): boolean {
  return indexOfBytes(source, needle, index) === index;
}

const BACKSLASH = 0x5c;

/**
 * Split a record's payload on separators tmux did not escape, and unescape.
 *
 * `#{q:…}` escapes the separator and the backslash alike, so a backslash run is
 * always even before an escaped byte and a separator preceded by an odd run is
 * part of a value. One pass does both jobs: deciding what is a boundary already
 * requires tracking the escapes that would be stripped a second time otherwise.
 *
 * Byte-wise rather than on text: a value can hold bytes that are not UTF-8 at
 * all, and decoding before splitting would replace them and move the offsets
 * the split depends on.
 */
function splitEscapedBytes(source: Uint8Array, separator: number): readonly Uint8Array[] {
  const fields: Uint8Array[] = [];
  let field: number[] = [];
  let escaped = false;
  for (const byte of source) {
    if (escaped) {
      field.push(byte);
      escaped = false;
      continue;
    }
    if (byte === BACKSLASH) {
      escaped = true;
      continue;
    }
    if (byte === separator) {
      fields.push(Uint8Array.from(field));
      field = [];
      continue;
    }
    field.push(byte);
  }
  // A trailing backslash cannot come from tmux — it escapes its own — so it is
  // kept rather than dropped, and the row that carries it fails its field count
  // or its schema rather than decoding to something plausible.
  if (escaped) field.push(BACKSLASH);
  fields.push(Uint8Array.from(field));
  return fields;
}

function frameBytes(
  request: GuardedFormatRequest,
  bytes: Uint8Array,
): readonly (readonly Uint8Array[])[] {
  const fieldGuard = bytesFor(request.guards.field)[0]!;
  const recordEndGuard = bytesFor(request.guards.recordEnd);
  const recordStartGuard = bytesFor(request.guards.recordStart);
  const frames: Array<readonly Uint8Array[]> = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (!bytesAt(bytes, recordStartGuard, offset)) {
      throw new FormatProtocolError(
        `guarded output has trailing or unframed bytes${framingEvidence(bytes, request.guards, offset)}`,
      );
    }
    const payloadStart = offset + recordStartGuard.length;
    const recordEnd = indexOfBytes(bytes, recordEndGuard, payloadStart);
    if (recordEnd < 0) {
      throw new FormatProtocolError(
        `guarded frame is incomplete${framingEvidence(bytes, request.guards, offset)}`,
      );
    }
    const nestedStart = indexOfBytes(bytes, recordStartGuard, payloadStart);
    if (nestedStart >= 0 && nestedStart < recordEnd) {
      throw new FormatProtocolError(
        `guarded frame contains a record-start collision${framingEvidence(bytes, request.guards, offset)}`,
      );
    }

    const fields = splitEscapedBytes(bytes.slice(payloadStart, recordEnd), fieldGuard);
    if (fields.length !== request.fields.length) {
      throw new FormatProtocolError("guarded frame has the wrong field count");
    }
    frames.push(fields);

    offset = recordEnd + recordEndGuard.length;
    if (offset === bytes.length) break;
    if (bytes[offset] !== 0x0a) {
      throw new FormatProtocolError("guarded frame has trailing bytes after its record end");
    }
    offset += 1;
    if (offset === bytes.length) break;
  }
  return frames;
}

function completeRowData(
  fields: readonly OutputFormatField[],
  values: readonly string[],
): RawCompleteFormatRow {
  const row = {} as Record<FormatFieldName, string | null>;
  for (const token of FORMAT_FIELD_TOKENS) row[token] = null;
  for (const [index, { token }] of fields.entries()) row[token] = values[index]!;
  return row;
}

function completeObj(row: CompleteFormatRow): ParsedFormatRow {
  const instance = Object.create(ParsedFormatRow.prototype) as Record<
    FormatFieldName,
    string | null
  >;
  for (const token of FORMAT_FIELD_TOKENS) instance[token] = row[token];
  return Object.freeze(instance) as ParsedFormatRow;
}

function primaryIdentity(listCommand: ListCommand): FormatFieldName {
  switch (listCommand) {
    case "list-clients":
      return "client_name";
    case "list-panes":
      return "pane_id";
    case "list-sessions":
      return "session_id";
    case "list-windows":
      return "window_id";
  }
}

function decodedStderr(bytes: Uint8Array): string {
  return decodeBackslashReplace(bytes).trimEnd();
}

const tmuxStderrByFailure = new WeakMap<LibTmuxException, string>();

function withTmuxStderr<Error extends LibTmuxException>(error: Error, stderr: string): Error {
  tmuxStderrByFailure.set(error, stderr);
  return error;
}

function commandFailure(
  listCommand: ListCommand,
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
  return withTmuxStderr(new LibTmuxException(message, { subcommand: listCommand }), stderr);
}

/**
 * Re-describe a transport failure as one, rather than as a generic exception.
 *
 * Flattening it into a bare {@link LibTmuxException} would give one timeout a
 * different observable type depending on which command hit it, and cost the
 * caller the `delivery` that says whether a retry is safe.
 */
function transportFailure(listCommand: ListCommand, error: TmuxTransportError): TmuxTransportError {
  const stderr = decodedStderr(error.stderr);
  return withTmuxStderr(
    new TmuxTransportError(stderr === "" ? error.message : stderr, {
      cause: error,
      delivery: error.delivery,
      kind: error.kind,
      ...(error.signal === undefined ? {} : { signal: error.signal }),
      stderr: error.stderr,
      stdout: error.stdout,
      subcommand: listCommand,
    }),
    stderr,
  );
}

export class GuardCodec {
  readonly #capabilities: TmuxCapabilities;
  readonly #guardFactory: GuardFactory;
  readonly #listCommand: ListCommand;
  readonly #requests = new WeakSet<GuardedFormatRequest>();

  constructor(options: GuardCodecOptions) {
    this.#capabilities = options.capabilities;
    this.#guardFactory = options.guardFactory ?? defaultGuardFactory;
    this.#listCommand = options.listCommand;
  }

  prepare(): GuardedFormatRequest {
    const guards = snapshotGuards(this.#guardFactory());
    const fields: readonly OutputFormatField[] = Object.freeze(
      formatFieldsForListCommand(this.#listCommand, this.#capabilities.rawVersion).map(
        ({ token }) => Object.freeze({ token }),
      ),
    );
    const request: GuardedFormatRequest = Object.freeze({
      capabilityFingerprint: this.#capabilities.fingerprint,
      fields,
      format: `${guards.recordStart}${fields.map(({ token }) => `#{q:${token}}`).join(guards.field)}${guards.recordEnd}`,
      guards,
      listCommand: this.#listCommand,
      tmuxVersion: snapshotVersion(this.#capabilities.tmuxVersion),
    });
    this.#requests.add(request);
    return request;
  }

  decode(request: GuardedFormatRequest, bytes: Uint8Array): readonly ParsedFormatRow[] {
    if (!this.#requests.has(request)) {
      throw new FormatProtocolError("foreign GuardedFormatRequest");
    }
    if (bytes.length === 0) return Object.freeze([]);

    const encodedFrames = frameBytes(request, bytes);
    const rows: ParsedFormatRow[] = [];
    for (const encodedFields of encodedFrames) {
      const decodedFields = encodedFields.map((field) => decodeBackslashReplace(field));
      if (decodedFields.some((value) => /^#\{[^}]+\}$/u.test(value))) {
        throw new FormatProtocolError("tmux returned a literal unknown format token");
      }

      let row: CompleteFormatRow;
      try {
        row = parseCompleteFormatRow(
          request.listCommand,
          completeRowData(request.fields, decodedFields),
        );
      } catch (error) {
        throw new FormatProtocolError("guarded row schema validation failed", { cause: error });
      }
      rows.push(completeObj(row));
    }
    return Object.freeze(rows);
  }
}

interface GuardedExecutionOptions {
  readonly capabilities: CapabilityBinding;
  readonly connection: TmuxConnection;
  readonly listExtraArgs?: readonly string[];
  /** Deadline for the listing, so acquisition is bounded like any command. */
  readonly timeoutMs?: number;
  readonly transport: CommandTransport;
}

export type GuardedListOptions = GuardedExecutionOptions & {
  readonly listCommand: ListCommand;
};

export interface GuardedListing {
  readonly listCommand: ListCommand;
  readonly listExtraArgs?: readonly string[];
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** Assign complete self-framed rows from one stdout stream to their codecs. */
function demultiplexGuardedOutput(
  requests: readonly GuardedFormatRequest[],
  bytes: Uint8Array,
): readonly Uint8Array[] {
  const starts = requests.map((request) => bytesFor(request.guards.recordStart));
  if (new Set(requests.map((request) => request.guards.recordStart)).size !== requests.length) {
    throw new FormatProtocolError("grouped listings have duplicate record guards");
  }
  const sections: Uint8Array[][] = requests.map(() => []);
  let offset = 0;
  let previous = 0;
  while (offset < bytes.length) {
    const index = starts.findIndex((guard) => bytesAt(bytes, guard, offset));
    if (index < 0) throw new FormatProtocolError("grouped listing output has unframed bytes");
    if (index < previous) throw new FormatProtocolError("grouped listing output is out of order");
    previous = index;
    const endGuard = bytesFor(requests[index]!.guards.recordEnd);
    const end = indexOfBytes(bytes, endGuard, offset + starts[index]!.length);
    if (end < 0) throw new FormatProtocolError("grouped listing output has an incomplete frame");
    let next = end + endGuard.length;
    if (next < bytes.length) {
      if (bytes[next] !== 0x0a) {
        throw new FormatProtocolError("grouped listing frame has trailing bytes");
      }
      next += 1;
    }
    sections[index]!.push(bytes.slice(offset, next));
    offset = next;
  }
  return Object.freeze(sections.map(concatenate));
}

export type GuardedFetchOptions = GuardedExecutionOptions &
  (
    | {
        readonly identityField: "client_name";
        readonly identityValue: string;
        readonly listCommand: "list-clients";
      }
    | {
        readonly identityField: "pane_id";
        readonly identityValue: string;
        readonly listCommand: "list-panes";
      }
    | {
        readonly identityField: "session_id";
        readonly identityValue: string;
        readonly listCommand: "list-sessions";
      }
    | {
        readonly identityField: "window_id";
        readonly identityValue: string;
        readonly listCommand: "list-windows";
      }
  );

export async function executeGuardedList(
  options: GuardedListOptions,
): Promise<readonly ParsedFormatRow[]> {
  const listExtraArgs: readonly string[] = Object.freeze([...(options.listExtraArgs ?? [])]);
  const capabilities = await options.capabilities.bind();
  const codec = new GuardCodec({ capabilities, listCommand: options.listCommand });
  const guardedRequest = codec.prepare();
  const commandRequest = prepareCommandRequest(
    options.connection,
    [options.listCommand, ...listExtraArgs, `-F${guardedRequest.format}`],
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );
  const currentCapabilities = await options.capabilities.bind();
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

/**
 * Run several listings as one tmux command list and decode each in turn.
 *
 * This is what makes a snapshot a snapshot. Issued separately, four listings are
 * four tmux clients with four command queues, and a window created between two
 * of them appears in one and not the other; issued as a list they are one queue,
 * drained without the event loop running in between. Measured under window
 * churn, separate listings tore about a fifth of their captures and this tore
 * none of 3340.
 *
 * Every listing is prepared against one capability binding, so a version change
 * mid-group is refused rather than decoded against the wrong field set.
 */
export async function executeGuardedListGroup(
  options: GuardedExecutionOptions & { readonly listings: readonly GuardedListing[] },
): Promise<readonly (readonly ParsedFormatRow[])[]> {
  if (options.listings.length === 0) return Object.freeze([]);
  const capabilities = await options.capabilities.bind();
  const prepared = options.listings.map((listing) => {
    const codec = new GuardCodec({ capabilities, listCommand: listing.listCommand });
    const request = codec.prepare();
    return {
      codec,
      command: [listing.listCommand, ...(listing.listExtraArgs ?? []), `-F${request.format}`],
      listCommand: listing.listCommand,
      request,
    };
  });

  const current = await options.capabilities.bind();
  if (prepared.some(({ request }) => current.fingerprint !== request.capabilityFingerprint)) {
    throw new FormatProtocolError("capability fingerprint changed before execution");
  }

  let result: RawCommandResult;
  try {
    result = await options.transport.execute(
      prepareInvocationRequest(
        options.connection,
        prepared.map(({ command }) => command),
        options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
      ),
    );
  } catch (error) {
    if (!(error instanceof TmuxTransportError)) throw error;
    throw transportFailure(prepared[0]?.listCommand ?? "list-sessions", error);
  }

  const failure = commandFailure(prepared[0]!.listCommand, result);
  if (failure !== undefined) throw failure;
  const sections = demultiplexGuardedOutput(
    prepared.map(({ request }) => request),
    result.stdout,
  );

  return Object.freeze(
    prepared.map(({ codec, request }, index) => codec.decode(request, sections[index]!)),
  );
}

export async function executeGuardedFetch(options: GuardedFetchOptions): Promise<ParsedFormatRow> {
  if (options.identityField !== primaryIdentity(options.listCommand)) {
    throw new FormatProtocolError("point identity field does not match its list command");
  }
  try {
    parseFormatIdentity(options.listCommand, options.identityValue);
  } catch (error) {
    throw new FormatProtocolError("point identity value does not match its list command", {
      cause: error,
    });
  }

  let rows: readonly ParsedFormatRow[];
  try {
    rows = await executeGuardedList(options);
  } catch (error) {
    if (
      !(error instanceof LibTmuxException) ||
      !isTargetNotFoundError(tmuxStderrByFailure.get(error) ?? "")
    ) {
      throw error;
    }
    throw new TmuxObjectDoesNotExist({
      list_cmd: options.listCommand,
      ...(options.listExtraArgs === undefined ? {} : { list_extra_args: options.listExtraArgs }),
      obj_id: options.identityValue,
      obj_key: options.identityField,
    });
  }
  const matches = rows.filter((row) => row[options.identityField] === options.identityValue);
  if (matches.length === 0) {
    throw new TmuxObjectDoesNotExist({
      list_cmd: options.listCommand,
      ...(options.listExtraArgs === undefined ? {} : { list_extra_args: options.listExtraArgs }),
      obj_id: options.identityValue,
      obj_key: options.identityField,
    });
  }
  return selectBestWinlink(matches);
}

export function isTargetNotFoundError(message: string): boolean {
  return message.includes("can't find ");
}

export function selectBestWinlink<
  Row extends Readonly<{
    window_active?: string | null;
    window_id?: string | null;
    window_index?: string | null;
  }>,
>(rows: readonly Row[]): Row {
  if (rows.length === 0) throw new FormatProtocolError("cannot select from an empty winlink set");
  if (rows.length === 1) return rows[0]!;
  for (const row of rows) {
    if (row.window_active === "1") return row;
  }

  const windowIndex = (row: Row): number => {
    if (
      row.window_index === undefined ||
      row.window_index === null ||
      !/^\d+$/u.test(row.window_index)
    ) {
      throw new FormatProtocolError("winlink row has an invalid window_index");
    }
    const index = Number.parseInt(row.window_index, 10);
    if (!Number.isSafeInteger(index)) {
      throw new FormatProtocolError("winlink row has an invalid window_index");
    }
    return index;
  };
  let selected = rows[0]!;
  let selectedIndex = windowIndex(selected);
  for (const row of rows.slice(1)) {
    const index = windowIndex(row);
    if (index < selectedIndex) {
      selected = row;
      selectedIndex = index;
    }
  }
  return selected;
}
