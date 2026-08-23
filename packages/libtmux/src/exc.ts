import { types as nodeTypes } from "node:util";

import type { DeliveryStatus } from "./common.js";

export type Query = Readonly<Record<string, unknown>>;

interface ExceptionOptions {
  readonly cause?: unknown;
  readonly subcommand?: string;
}

interface ObjectDoesNotExistOptions extends ExceptionOptions {
  readonly message?: string;
  readonly query?: Query;
}

interface MultipleObjectsReturnedOptions extends ObjectDoesNotExistOptions {
  readonly count?: number;
}

const maximumQueryFormatDepth = 256;
const maximumQueryDepthValue = JSON.stringify("[query value exceeds maximum depth]");

function sortedDataEntries(value: object): readonly (readonly [string, unknown])[] | null {
  try {
    if (nodeTypes.isProxy(value) || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      entries.push([key, descriptor.value]);
    }
    return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  } catch {
    return null;
  }
}

function dataArrayValues(value: object): readonly unknown[] | null {
  try {
    if (nodeTypes.isProxy(value) || !Array.isArray(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
    ) {
      return null;
    }
    const values: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

function formatDataValue(value: unknown, active: Set<object>, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return "null";
  }
  if (depth >= maximumQueryFormatDepth) return maximumQueryDepthValue;
  if (active.has(value)) return JSON.stringify("[circular query value]");
  active.add(value);
  try {
    const array = dataArrayValues(value);
    if (array !== null) {
      return `[${array.map((entry) => formatDataValue(entry, active, depth + 1)).join(",")}]`;
    }
    const entries = sortedDataEntries(value);
    if (entries === null) return JSON.stringify("[invalid query value]");
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${formatDataValue(entry, active, depth + 1)}`)
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function formatQuery(query: Query): string {
  const entries = sortedDataEntries(query);
  if (entries === null) return "";
  return entries
    .map(([key, value]) =>
      typeof value === "string"
        ? `${key}='${value}'`
        : `${key}=${formatDataValue(value, new Set())}`,
    )
    .join(", ");
}

export interface TmuxCommandFailureOptions extends ExceptionOptions {
  /** The full argument vector, without the connection flags. */
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: readonly string[];
  /** Whatever the command printed before it failed. */
  readonly stdout?: readonly string[];
  /** The `-t` target the command addressed, when it had one. */
  readonly target?: string | undefined;
}

export class LibTmuxException extends Error {
  readonly subcommand: string | undefined;

  constructor(message = "", options: ExceptionOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.subcommand = options.subcommand;
  }

  override toString(): string {
    return this.subcommand === undefined
      ? `${this.name}: ${this.message}`
      : `${this.subcommand}: ${this.message}`;
  }
}

/** What went wrong between this process and tmux, as opposed to inside tmux. */
export type TmuxTransportErrorKind = "cancelled" | "pipe" | "protocol" | "spawn" | "timeout";

/**
 * A command did not complete, and this is how far it got.
 *
 * The reason this is on the error rather than inferred from it: after a
 * timeout, "did tmux run this?" has no default answer, and retrying a mutation
 * that already applied is how one `kill-session` becomes two. `not_started` is
 * the only status a caller may retry blindly.
 */
export class TmuxTransportError extends LibTmuxException {
  readonly #stderr: Uint8Array;
  readonly #stdout: Uint8Array;
  /** How far the command got before this failure. */
  readonly delivery: DeliveryStatus;
  /** Which part of reaching tmux failed. */
  readonly kind: TmuxTransportErrorKind;
  /**
   * The signal that ended the process, when one did.
   *
   * A plain string rather than Node's `NodeJS.Signals`: these declarations are
   * gated to compile with no ambient Node types, and a consumer compares this
   * against `"SIGKILL"` either way.
   */
  readonly signal: string | null | undefined;

  constructor(message: string, options: TmuxTransportErrorOptions) {
    super(message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.subcommand === undefined ? {} : { subcommand: options.subcommand }),
    });
    this.name = "TmuxTransportError";
    this.delivery = options.delivery;
    this.kind = options.kind;
    this.signal = options.signal;
    this.#stderr = new Uint8Array(options.stderr ?? []);
    this.#stdout = new Uint8Array(options.stdout ?? []);
  }

  /** Whatever tmux wrote to stderr before the failure, copied. */
  get stderr(): Uint8Array {
    return new Uint8Array(this.#stderr);
  }

  /** Whatever tmux wrote to stdout before the failure, copied. */
  get stdout(): Uint8Array {
    return new Uint8Array(this.#stdout);
  }
}

export interface TmuxTransportErrorOptions extends ExceptionOptions {
  readonly delivery: DeliveryStatus;
  readonly kind: TmuxTransportErrorKind;
  readonly signal?: string | null;
  readonly stderr?: Uint8Array;
  readonly stdout?: Uint8Array;
}

export class DeprecatedError extends LibTmuxException {
  constructor({
    deprecated,
    replacement,
    version,
  }: {
    deprecated: string;
    replacement: string;
    version: string;
  }) {
    super(
      `${deprecated} was deprecated in ${version} and has been removed. Use ${replacement} instead.`,
    );
  }
}

export class TmuxSessionExists extends LibTmuxException {}
export class TmuxCommandNotFound extends LibTmuxException {}

export class NotInsideTmux extends LibTmuxException {
  constructor(variable?: string, options: { readonly reason?: string } = {}) {
    super(
      variable === undefined
        ? "Not inside a tmux pane"
        : `Not inside a tmux pane: $${variable} is ${options.reason ?? "unset or empty"}`,
    );
  }
}

export class ObjectDoesNotExist extends LibTmuxException {
  readonly query: Query | undefined;

  constructor(options: ObjectDoesNotExistOptions = {}) {
    const formattedQuery = options.query === undefined ? "" : formatQuery(options.query);
    const message =
      options.message ??
      (formattedQuery === "" ? "No objects found" : `No objects found: ${formattedQuery}`);
    super(message, options);
    this.query = options.query;
  }
}

export class MultipleObjectsReturned extends LibTmuxException {
  readonly count: number | undefined;
  readonly query: Query | undefined;

  constructor(options: MultipleObjectsReturnedOptions = {}) {
    const parts = ["Multiple objects returned"];
    if (options.count !== undefined) parts.push(`(${options.count})`);
    const formattedQuery = options.query === undefined ? "" : formatQuery(options.query);
    const message =
      options.message ?? `${parts.join(" ")}${formattedQuery === "" ? "" : `: ${formattedQuery}`}`;
    super(message, options);
    this.count = options.count;
    this.query = options.query;
  }
}

export class TmuxObjectDoesNotExist extends ObjectDoesNotExist {
  constructor(
    options: {
      readonly list_cmd?: string;
      readonly list_extra_args?: readonly string[];
      readonly obj_id?: string;
      readonly obj_key?: string;
    } = {},
  ) {
    const { list_cmd, list_extra_args, obj_id, obj_key } = options;
    super({
      message:
        list_cmd === undefined ||
        list_extra_args === undefined ||
        obj_id === undefined ||
        obj_key === undefined
          ? "Could not find object"
          : `Could not find ${obj_key}=${obj_id} for ${list_cmd} (${list_extra_args.map((value) => `'${value}'`).join(", ")})`,
    });
  }
}

/**
 * A field the server is too old to have.
 *
 * Constructed bare for parity with the Python library, which has this name and
 * throws it with no message. Constructed with its parts by this package, so a
 * caller filtering on a field their tmux predates is told which field, which
 * release has it, and which release answered — rather than being handed an
 * empty result that reads as "no object has this".
 */
export class VersionTooLow extends LibTmuxException {
  /** The criteria key the caller wrote, when this came from a query. */
  readonly criteriaName?: string;
  /** The tmux that answered, when this came from a query. */
  readonly serverVersion?: string;
  /** The first tmux that has the field, when this came from a query. */
  readonly since?: string;

  constructor(options?: {
    readonly criteriaName: string;
    readonly serverVersion: string;
    readonly since: string;
  }) {
    super(
      options === undefined
        ? ""
        : `${options.criteriaName} needs tmux ${options.since}; this server is ${options.serverVersion}`,
    );
    if (options === undefined) return;
    this.criteriaName = options.criteriaName;
    this.serverVersion = options.serverVersion;
    this.since = options.since;
  }
}

export class BadSessionName extends LibTmuxException {
  constructor(reason: string, session_name?: string) {
    super(
      `Bad session name: ${reason}${session_name === undefined ? "" : ` (session name: ${session_name})`}`,
    );
  }
}

export class OptionError extends LibTmuxException {}
export class UnknownOption extends OptionError {}
export class UnknownColorOption extends UnknownOption {
  constructor() {
    super("Server.colors must equal 88 or 256");
  }
}
export class InvalidOption extends OptionError {}
export class AmbiguousOption extends OptionError {}
export class WaitTimeout extends LibTmuxException {}

export class VariableUnpackingError extends LibTmuxException {
  constructor(variable?: unknown) {
    const value =
      variable === undefined
        ? "None"
        : typeof variable === "object"
          ? Object.prototype.toString.call(variable)
          : String(variable as string | number | bigint | boolean | symbol);
    super(`Unexpected variable: ${value}`);
  }
}

export class PaneError extends LibTmuxException {}
export class PaneNotFound extends PaneError {
  constructor(pane_id?: string) {
    super(pane_id === undefined ? "Pane not found" : `Pane not found: ${pane_id}`);
  }
}

export class WindowError extends LibTmuxException {}
export class MultipleActiveWindows extends WindowError {
  constructor(count: number) {
    super(`Multiple active windows: ${count} found`);
  }
}
export class NoActiveWindow extends WindowError {
  constructor() {
    super("No active windows found");
  }
}
export class NoWindowsExist extends WindowError {
  constructor() {
    super("No windows exist for object");
  }
}

const adjustmentDirectionInstances = new WeakSet<object>();

export class AdjustmentDirectionRequiresAdjustment extends LibTmuxException {
  constructor(options: ExceptionOptions = {}) {
    super("adjustment_direction requires adjustment", options);
    adjustmentDirectionInstances.add(this);
  }
}
export class WindowAdjustmentDirectionRequiresAdjustment extends WindowError {
  constructor(options: ExceptionOptions = {}) {
    super("adjustment_direction requires adjustment", options);
    adjustmentDirectionInstances.add(this);
  }
}
export class PaneAdjustmentDirectionRequiresAdjustment extends WindowError {
  constructor(options: ExceptionOptions = {}) {
    super("adjustment_direction requires adjustment", options);
    adjustmentDirectionInstances.add(this);
  }
}

Object.defineProperty(AdjustmentDirectionRequiresAdjustment, Symbol.hasInstance, {
  value(this: Function, value: unknown): boolean {
    if (this === AdjustmentDirectionRequiresAdjustment) {
      return typeof value === "object" && value !== null && adjustmentDirectionInstances.has(value);
    }
    return Function.prototype[Symbol.hasInstance].call(this, value);
  },
});
export class RequiresDigitOrPercentage extends LibTmuxException {
  constructor() {
    super("Requires digit (int or str digit) or a percentage.");
  }
}

export class NoMatchError extends ObjectDoesNotExist {}
export class MultipleMatchesError extends MultipleObjectsReturned {}

export type QueryValidationErrorCode = "invalid-id" | "invalid-query";

export class QueryValidationError extends LibTmuxException {
  readonly code: QueryValidationErrorCode;
  /**
   * Where in the criteria the problem is, as keys and array indices.
   *
   * `["windows", "some", "name", "startsWith"]` reads as
   * `windows.some.name.startsWith`, which is what the message renders. Kept
   * apart from the message so a caller that built the criteria from somewhere
   * else — a form, a config file, an MCP client — can point at the right field
   * rather than parse a sentence. Empty when the criteria themselves are not an
   * object at all.
   */
  readonly path: readonly (string | number)[];

  constructor({
    cause,
    code,
    message,
    path = [],
  }: {
    readonly cause?: unknown;
    readonly code: QueryValidationErrorCode;
    readonly message: string;
    readonly path?: readonly (string | number)[];
  }) {
    super(message, { cause });
    this.code = code;
    this.path = Object.freeze([...path]);
  }
}

/**
 * A handle outlived the daemon that issued its id.
 *
 * tmux numbers a restarted daemon's objects from the start, so `%1` from before
 * the restart names a pane that exists and belongs to somebody else. Raised
 * from two places for one reason: the local check, when an acquisition has
 * already seen the new daemon, and tmux itself, when it has not — the command
 * carries a condition on the daemon's pid and start time and takes a branch
 * that refuses instead of running.
 *
 * `delivery` is always `not_started`: the whole point of the condition is that
 * a refused command never ran, so retrying against a fresh handle is safe.
 *
 * ```ts
 * try {
 *   await pane.kill();
 * } catch (error) {
 *   if (error instanceof TmuxServerRestarted) {
 *     // Read the server again; this pane's id belongs to another daemon now.
 *   }
 * }
 * ```
 */
export class TmuxServerRestarted extends LibTmuxException {
  /** How far the refused command got, which is nowhere. */
  readonly delivery: DeliveryStatus = "not_started";

  constructor(message: string, options: ExceptionOptions = {}) {
    super(message, options);
    this.name = "TmuxServerRestarted";
  }
}

/**
 * A tmux command that exited non-zero.
 *
 * The parts are fields rather than a formatted sentence so callers can branch
 * on them. Matching a message substring is the failure mode this replaces: it
 * breaks silently when tmux rewords, and it cannot distinguish "already in the
 * requested state" from a genuine error.
 */
export class TmuxCommandError extends LibTmuxException {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: readonly string[];
  /**
   * Whatever the command printed before it failed.
   *
   * tmux writes as it goes, so a command that fails part-way has usually said
   * something first. Dropping it loses the only record of how far it got.
   */
  readonly stdout: readonly string[];
  readonly target: string | undefined;

  constructor(options: TmuxCommandFailureOptions) {
    const subcommand = options.args[0] ?? "tmux";
    super(`${subcommand} failed: ${options.stderr.join("; ")}`, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      subcommand,
    });
    this.args = Object.freeze([...options.args]);
    this.exitCode = options.exitCode;
    this.stderr = Object.freeze([...options.stderr]);
    this.stdout = Object.freeze([...(options.stdout ?? [])]);
    this.target = options.target;
  }

  /** Whether tmux's own message contains a phrase, without message parsing at call sites. */
  stderrIncludes(phrase: string): boolean {
    return this.stderr.some((line) => line.includes(phrase));
  }
}
