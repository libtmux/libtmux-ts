/**
 * The limits this process enforces, resolved once from the environment.
 *
 * An MCP client supplies an environment and a command line and nothing else, so
 * the environment is the only place an operator can reach. The library itself
 * reads none of these — a library that picks up ambient configuration surprises
 * its caller — which is why the reading happens here, at the edge that has a
 * process to belong to.
 */

import { MAX_PACKED_ARGV_BYTES } from "libtmux/engine";

/** How much a tool may return before it starts linking instead of inlining. */
export const DEFAULT_MAX_RESULT_LINES = 200;

/** Largest complete serialized MCP result, including its protocol envelope. */
export const MAX_RESULT_BYTES = 1_000_000;

/** Largest UTF-8 payload a request may stage or collect across repeated items. */
export const MAX_REQUEST_BYTES = MAX_RESULT_BYTES;

/** Largest quoted request text within one tmux invocation. */
export const MAX_INLINE_REQUEST_BYTES = Math.floor(MAX_PACKED_ARGV_BYTES / 2);

// A share of what tmux carries, floored: these are byte counts, and the
// argv budget is not a multiple of eight.
/** Largest command before its five-byte-per-byte shell framing. */
export const MAX_FRAMED_COMMAND_BYTES = Math.floor(MAX_PACKED_ARGV_BYTES / 8);

/** Most repeated operations one request may schedule. */
export const MAX_REQUEST_ITEMS = 64;

/**
 * How long a blocking wait may run.
 *
 * The ceiling bounds the agent's turn, not the transport: waits await
 * throughout, so a long one does not stall the connection.
 */
export const DEFAULT_BLOCKING_WAIT_MS = 30_000;

/** How long a single tmux command may run before it is killed. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const BLOCKING_WAIT_FLOOR_MS = 1_000;
const BLOCKING_WAIT_LIMIT_MS = 120_000;
/** Largest delay accepted by libtmux's timer-backed command deadline. */
const COMMAND_TIMEOUT_LIMIT_MS = 2_147_483_647;
const MAX_RESULT_LINES_LIMIT = 10_000;

export const TOOLSETS = ["inspect", "manage", "execute", "teardown"] as const;
export type Toolset = (typeof TOOLSETS)[number];
const CONSERVATIVE_DEFAULT_TOOLSETS: readonly Toolset[] = ["inspect", "manage", "execute"];

export interface Policy {
  /** Ceiling on a wait that blocks the caller. */
  readonly blockingWaitMaxMs: number;
  readonly commandTimeoutMs: number;
  /** Whether tools may hold one control-mode connection for streaming. */
  readonly liveEnabled: boolean;
  readonly maxResultLines: number;
  /** Toolsets selected before named inclusion and exclusion. */
  readonly toolsets: ReadonlySet<Toolset>;
  /** Tool names added after toolset expansion. */
  readonly tools: ReadonlySet<string>;
  /** Tool names removed last, winning over both inclusion paths. */
  readonly excludeTools: ReadonlySet<string>;
}

function clamp(value: number, floor: number, limit: number): number {
  return Math.min(Math.max(value, floor), limit);
}

/**
 * Read a positive integer, or fall back.
 *
 * A value that does not parse is a typo in a config file, not an intent, so it
 * falls back rather than failing the launch — an MCP server that refuses to
 * start is one whose message the agent never sees.
 */
function readInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/u.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readList(
  variable: string,
  raw: string | undefined,
  allowEmpty = false,
): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  if (raw === "") {
    if (allowEmpty) return new Set();
    throw new TypeError(`${variable} contains an empty token`);
  }
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value === "")) {
    throw new TypeError(`${variable} contains an empty token`);
  }
  return new Set(values);
}

export function resolvePolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  defaultToolsets: readonly Toolset[] = CONSERVATIVE_DEFAULT_TOOLSETS,
): Policy {
  if (Object.prototype.hasOwnProperty.call(environment, "LIBTMUX_SAFETY")) {
    throw new TypeError("LIBTMUX_SAFETY is no longer supported; use LIBTMUX_TOOLSETS");
  }
  if (Object.prototype.hasOwnProperty.call(environment, "LIBTMUX_MCP_TOOLS")) {
    throw new TypeError(
      "LIBTMUX_MCP_TOOLS is no longer supported; use LIBTMUX_TOOLSETS and LIBTMUX_TOOLS",
    );
  }
  const selected = readList(
    "LIBTMUX_TOOLSETS",
    environment.LIBTMUX_TOOLSETS ?? defaultToolsets.join(","),
    true,
  );
  for (const name of selected) {
    if (!(TOOLSETS as readonly string[]).includes(name)) {
      throw new TypeError(`LIBTMUX_TOOLSETS names unknown toolset ${name}`);
    }
  }
  return {
    blockingWaitMaxMs: clamp(
      readInteger(environment.LIBTMUX_MCP_WAIT_MAX_MS, DEFAULT_BLOCKING_WAIT_MS),
      BLOCKING_WAIT_FLOOR_MS,
      BLOCKING_WAIT_LIMIT_MS,
    ),
    commandTimeoutMs: Math.min(
      readInteger(environment.LIBTMUX_MCP_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS),
      COMMAND_TIMEOUT_LIMIT_MS,
    ),
    liveEnabled: environment.LIBTMUX_MCP_LIVE !== "0",
    maxResultLines: clamp(
      readInteger(environment.LIBTMUX_MCP_MAX_RESULT_LINES, DEFAULT_MAX_RESULT_LINES),
      1,
      MAX_RESULT_LINES_LIMIT,
    ),
    excludeTools: readList("LIBTMUX_EXCLUDE_TOOLS", environment.LIBTMUX_EXCLUDE_TOOLS),
    tools: readList("LIBTMUX_TOOLS", environment.LIBTMUX_TOOLS),
    toolsets: new Set(selected as ReadonlySet<Toolset>),
  };
}

function requireInteger(field: string, value: number, floor: number, limit: number): void {
  if (!Number.isSafeInteger(value) || value < floor || value > limit) {
    throw new TypeError(`policy.${field} must be an integer from ${floor} to ${limit}`);
  }
}

/** Validate and detach a policy supplied through the public JavaScript boundary. */
export function snapshotPolicy(policy: Policy): Policy {
  if (typeof policy !== "object" || policy === null) {
    throw new TypeError("policy must be an object");
  }

  const {
    blockingWaitMaxMs,
    commandTimeoutMs,
    excludeTools,
    liveEnabled,
    maxResultLines,
    tools,
    toolsets,
  } = policy;
  requireInteger(
    "blockingWaitMaxMs",
    blockingWaitMaxMs,
    BLOCKING_WAIT_FLOOR_MS,
    BLOCKING_WAIT_LIMIT_MS,
  );
  requireInteger("commandTimeoutMs", commandTimeoutMs, 1, COMMAND_TIMEOUT_LIMIT_MS);
  if (typeof liveEnabled !== "boolean") {
    throw new TypeError("policy.liveEnabled must be a boolean");
  }
  requireInteger("maxResultLines", maxResultLines, 1, MAX_RESULT_LINES_LIMIT);
  const copySet = (field: string, source: ReadonlySet<unknown>): ReadonlySet<string> => {
    const copy = new Set<string>();
    try {
      Set.prototype.forEach.call(source, (name: unknown): void => {
        if (typeof name !== "string" || name === "") {
          throw new TypeError(`policy.${field} must contain only nonempty strings`);
        }
        copy.add(name);
      });
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith("policy.")) throw error;
      throw new TypeError(`policy.${field} must be a Set`);
    }
    return copy;
  };
  const toolsetSnapshot = copySet("toolsets", toolsets);
  for (const name of toolsetSnapshot) {
    if (!(TOOLSETS as readonly string[]).includes(name)) {
      throw new TypeError(`policy.toolsets contains unknown toolset ${name}`);
    }
  }

  return {
    blockingWaitMaxMs,
    commandTimeoutMs,
    liveEnabled,
    maxResultLines,
    excludeTools: copySet("excludeTools", excludeTools),
    tools: copySet("tools", tools),
    toolsets: new Set(toolsetSnapshot as ReadonlySet<Toolset>),
  };
}

/** Keep a caller's requested line count inside the operator's ceiling. */
export function effectiveResultLines(policy: Policy, requested: number | undefined): number {
  const configured = Number.isSafeInteger(policy.maxResultLines)
    ? policy.maxResultLines
    : DEFAULT_MAX_RESULT_LINES;
  const ceiling = clamp(configured, 1, MAX_RESULT_LINES_LIMIT);
  const desired =
    requested === undefined || !Number.isSafeInteger(requested)
      ? ceiling
      : clamp(requested, 1, MAX_RESULT_LINES_LIMIT);
  return Math.min(desired, ceiling);
}

/**
 * The wait this server will actually perform, given what was asked for.
 *
 * Clamp, never reject: an over-large timeout is not an error, and answering it
 * with one costs the agent a turn to learn a policy the result could have
 * carried. The honoured value comes back on every wait result instead.
 */
export function effectiveWaitMs(policy: Policy, requested: number | undefined): number {
  const ceiling = policy.blockingWaitMaxMs;
  return requested === undefined
    ? Math.min(DEFAULT_BLOCKING_WAIT_MS, ceiling)
    : Math.min(requested, ceiling);
}
