/**
 * The limits this process enforces, resolved once from the environment.
 *
 * An MCP client supplies an environment and a command line and nothing else, so
 * the environment is the only place an operator can reach. The library itself
 * reads none of these — a library that picks up ambient configuration surprises
 * its caller — which is why the reading happens here, at the edge that has a
 * process to belong to.
 */

/** How much a tool may return before it starts linking instead of inlining. */
export const DEFAULT_MAX_RESULT_LINES = 200;

/** Largest tmux-derived UTF-8 payload per result; fixed notices may add a small overhead. */
export const MAX_RESULT_BYTES = 256 * 1024;

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
const MAX_RESULT_LINES_LIMIT = 10_000;

/**
 * Which tools this server offers.
 *
 * A tier is a hidden-tool decision rather than a refusal at call time: a tool an
 * agent cannot see is one it cannot spend a turn being denied.
 */
export type SafetyTier = "destructive" | "mutating" | "readonly";

const TIER_RANK: Readonly<Record<SafetyTier, number>> = {
  destructive: 2,
  mutating: 1,
  readonly: 0,
};

export interface Policy {
  /** Ceiling on a wait that blocks the caller. */
  readonly blockingWaitMaxMs: number;
  readonly commandTimeoutMs: number;
  /** Whether tools may hold one control-mode connection for streaming. */
  readonly liveEnabled: boolean;
  readonly maxResultLines: number;
  readonly safety: SafetyTier;
  /**
   * The only tools to offer, when an operator has narrowed it that far.
   *
   * A tier answers "how much may this agent change"; this answers "which of it".
   * Pointing a fleet at one tmux server is where the difference matters: read
   * and type, never kill, is a shape no tier has because killing is not a
   * degree of typing.
   *
   * Undefined offers everything the tier allows, which is the common case and
   * the one that needs no configuration.
   */
  readonly tools: ReadonlySet<string> | undefined;
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

/**
 * Read a comma-separated allowlist, treating an empty value as no list.
 *
 * Not as an empty list: a variable someone set and left blank means "I did not
 * decide", and answering it with a server that offers nothing is a puzzle
 * rather than a policy.
 */
function readToolAllowlist(raw: string | undefined): ReadonlySet<string> | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return names.length === 0 ? undefined : new Set(names);
}

/**
 * Read a tier, narrowing rather than widening on a name nobody recognises.
 *
 * Falling back is right for the same reason {@link readInteger} does it: the
 * variable comes from wherever the process was started, and a server that
 * refuses to launch takes its explanation with it. Falling back *upward* is
 * not. `read-only` and `read_only` are how `readonly` is usually mistyped, and
 * answering them with the default hands an agent the tools the operator was
 * trying to withhold — a mistake that looks exactly like a working
 * configuration. The startup line names the tier in force, which is where
 * this becomes visible.
 */
function readSafety(raw: string | undefined): SafetyTier {
  if (raw === undefined) return "readonly";
  const named = raw.trim().toLowerCase();
  if (named === "readonly" || named === "read-only") return "readonly";
  if (named === "mutating" || named === "destructive") return named;
  return "readonly";
}

export function resolvePolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Policy {
  return {
    blockingWaitMaxMs: clamp(
      readInteger(environment.LIBTMUX_MCP_WAIT_MAX_MS, DEFAULT_BLOCKING_WAIT_MS),
      BLOCKING_WAIT_FLOOR_MS,
      BLOCKING_WAIT_LIMIT_MS,
    ),
    commandTimeoutMs: readInteger(
      environment.LIBTMUX_MCP_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS,
    ),
    liveEnabled: environment.LIBTMUX_MCP_LIVE !== "0",
    maxResultLines: clamp(
      readInteger(environment.LIBTMUX_MCP_MAX_RESULT_LINES, DEFAULT_MAX_RESULT_LINES),
      1,
      MAX_RESULT_LINES_LIMIT,
    ),
    safety: readSafety(environment.LIBTMUX_SAFETY),
    tools: readToolAllowlist(environment.LIBTMUX_MCP_TOOLS),
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

/** Whether a tool needing `required` is offered under `active`. */
export function tierAllows(active: SafetyTier, required: SafetyTier): boolean {
  return TIER_RANK[active] >= TIER_RANK[required];
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
