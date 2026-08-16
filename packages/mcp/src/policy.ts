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

/**
 * How long a blocking wait may run.
 *
 * The ceiling bounds the agent's turn, not the transport: waits await
 * throughout, so a long one does not stall the connection. What it costs is the
 * agent — it picks the wrong marker once and the whole turn is gone with nothing
 * to show for it, and a plain tool call gives it no way to change its mind
 * mid-flight.
 */
export const DEFAULT_BLOCKING_WAIT_MS = 30_000;

/**
 * How long the same wait may run as a task.
 *
 * A task hands back a handle immediately and can be cancelled, so the reason the
 * blocking ceiling is low does not apply. What remains is tmux's own limit:
 * `grid_collect_history` frees the oldest scrollback once `history-limit` is
 * reached, which invalidates the anchor a long observation is measured from.
 */
export const DEFAULT_TASK_WAIT_MS = 600_000;

/** How long a single tmux command may run before it is killed. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const BLOCKING_WAIT_FLOOR_MS = 1_000;
const BLOCKING_WAIT_LIMIT_MS = 120_000;
const TASK_WAIT_FLOOR_MS = 1_000;
const TASK_WAIT_LIMIT_MS = 3_600_000;

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
  /** Ceiling on a wait running as a task. */
  readonly taskWaitMaxMs: number;
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
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSafety(raw: string | undefined): SafetyTier {
  return raw === "readonly" || raw === "destructive" || raw === "mutating" ? raw : "mutating";
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
    maxResultLines: readInteger(environment.LIBTMUX_MCP_MAX_RESULT_LINES, DEFAULT_MAX_RESULT_LINES),
    safety: readSafety(environment.LIBTMUX_SAFETY),
    taskWaitMaxMs: clamp(
      readInteger(environment.LIBTMUX_MCP_TASK_WAIT_MAX_MS, DEFAULT_TASK_WAIT_MS),
      TASK_WAIT_FLOOR_MS,
      TASK_WAIT_LIMIT_MS,
    ),
  };
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
export function effectiveWaitMs(
  policy: Policy,
  requested: number | undefined,
  asTask: boolean,
): number {
  const ceiling = asTask ? policy.taskWaitMaxMs : policy.blockingWaitMaxMs;
  return requested === undefined
    ? Math.min(DEFAULT_BLOCKING_WAIT_MS, ceiling)
    : Math.min(requested, ceiling);
}
