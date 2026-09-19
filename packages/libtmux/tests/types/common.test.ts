import type { AbortLike } from "../../src/types.js";
import type {
  CommandOptions,
  CommandOutcome,
  CommandResult,
  ConnectionAlias,
  DaemonEpoch,
  LogicalRef,
  DeliveryStatus,
  OperationStatus,
  SafeInteger,
  PaneId,
  PaneRef,
  SessionId,
  SessionRef,
  WindowId,
  WindowRef,
} from "../../src/common.js";
import type { TmuxInvocationObserver, TmuxInvocationReport } from "../../src/common.js";
import { isSafeInteger, safeInteger } from "../../src/common.js";
import type { LibTmuxErrorCode } from "../../src/errors.js";
import type { WaitTimeoutError } from "../../src/errors.js";
import type { DefaultOptionScope } from "../../src/constants.js";
import * as exception from "../../src/exc.js";
import { MultipleMatchesError, NoMatchError, QueryValidationError } from "../../src/errors.js";
import {
  OptionScope,
  DEFAULT_OPTION_SCOPE,
  HOOK_SCOPE_FLAG_MAP,
  OPTION_SCOPE_FLAG_MAP,
  PaneDirection,
  PANE_DIRECTION_FLAG_MAP,
  ResizeAdjustmentDirection,
  RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP,
  WindowDirection,
  WINDOW_DIRECTION_FLAG_MAP,
} from "../../src/constants.js";
import {
  isSafeInteger as rootIsSafeInteger,
  isSplitSize as rootIsSplitSize,
  OptionScope as RootOptionScope,
  safeInteger as rootSafeInteger,
  splitSize as rootSplitSize,
} from "../../src/index.js";
import type {
  CommandOptions as RootCommandOptions,
  HookScope,
  JoinOptions as RootJoinOptions,
  OptionScope as RootOptionScopeType,
  SetOptionOptions as RootSetOptionOptions,
  SafeInteger as RootSafeInteger,
  SplitCellSize as RootSplitCellSize,
  SplitPercentage as RootSplitPercentage,
  SplitSize as RootSplitSize,
} from "../../src/index.js";
import { isSplitSize, splitSize } from "../../src/types.js";
import type {
  JoinOptions,
  SetOptionOptions,
  SplitCellSize,
  SplitPercentage,
  SplitSize,
} from "../../src/types.js";

import type { Equal, Expect } from "./assert.js";

declare const options: CommandOptions;
declare const result: CommandResult;
declare const outcome: CommandOutcome;
declare const ref: LogicalRef;
declare const sessionRef: SessionRef;
declare const windowRef: WindowRef;
declare const paneRef: PaneRef;

void options.signal;
void options.stdin;
void result.cmd;
void result.stdout;
void result.stderr;
void result.exitCode;
void outcome.delivery;
void outcome.result;
void outcome.status;
void ref.connection;
void ref.epoch;
void ref.id;
void ref.kind;
void sessionRef.id;
void windowRef.id;
void paneRef.id;

// @ts-expect-error Command results are readonly snapshots.
result.exitCode = 1;
// @ts-expect-error Outcomes are readonly snapshots.
outcome.status = "failed";
// @ts-expect-error Logical references are readonly.
sessionRef.kind = "window";
// @ts-expect-error Flag maps are readonly.
RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP[ResizeAdjustmentDirection.Up] = "-D";
// @ts-expect-error The sentinel is nominal rather than a plain object.
const plainDefaultScope: DefaultOptionScope = {};
void plainDefaultScope;

const exceptionCause = new Error("cause");
const noMatch = new NoMatchError({
  cause: exceptionCause,
  message: "No match",
  query: { pane_id: "%3" },
  subcommand: "list-panes",
});
const multipleMatches = new MultipleMatchesError({
  cause: exceptionCause,
  count: 2,
  message: "Multiple matches",
  query: { pane_id: "%3" },
  subcommand: "list-panes",
});
const invalidQuery = new QueryValidationError({
  cause: exceptionCause,
  reason: "invalid-query",
  message: "Invalid query",
});

void noMatch.query;
void multipleMatches.count;
void invalidQuery.code;
type _ExceptionNamespace = Expect<
  Equal<
    keyof typeof exception,
    | "LibTmuxError"
    | "LibTmuxException"
    | "MultipleMatchesError"
    | "MultipleObjectsError"
    | "MultipleObjectsReturned"
    | "NoMatchError"
    | "ObjectDoesNotExist"
    | "ObjectNotFoundError"
    | "QueryValidationError"
    | "TmuxCommandError"
    | "TmuxObjectDoesNotExist"
    | "TmuxObjectNotFoundError"
    | "TmuxServerRestarted"
    | "TmuxServerRestartedError"
    | "TmuxTransportError"
    | "VersionTooLow"
    | "VersionTooLowError"
    | "WaitTimeout"
    | "WaitTimeoutError"
  >
>;
void OptionScope.Server;
void RootOptionScope.Server;
void PaneDirection.Above;
void ResizeAdjustmentDirection.Up;
void WindowDirection.Before;
void DEFAULT_OPTION_SCOPE;
void RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP;
void WINDOW_DIRECTION_FLAG_MAP;
void PANE_DIRECTION_FLAG_MAP;
void OPTION_SCOPE_FLAG_MAP;
void HOOK_SCOPE_FLAG_MAP;

type _DeliveryStatus = Expect<
  Equal<DeliveryStatus, "not_started" | "written" | "replied" | "indeterminate">
>;
type _OperationStatus = Expect<
  Equal<OperationStatus, "complete" | "failed" | "skipped" | "unknown">
>;
type _CommandOutcomeKeys = Expect<Equal<keyof CommandOutcome, "delivery" | "result" | "status">>;
type _CommandOptions = Expect<
  Equal<
    CommandOptions,
    {
      readonly signal?: AbortLike;
      readonly stdin?: string | Uint8Array;
      readonly timeoutMs?: number;
    }
  >
>;
type _CommandResult = Expect<
  Equal<
    CommandResult,
    {
      readonly cmd: readonly string[];
      readonly exitCode: number;
      readonly stderr: readonly string[];
      readonly stdout: readonly string[];
    }
  >
>;
type _CommandOutcome = Expect<
  Equal<
    CommandOutcome,
    {
      readonly delivery: DeliveryStatus;
      readonly result?: CommandResult;
      readonly status: OperationStatus;
    }
  >
>;
type _InvocationObserver = Expect<
  Equal<TmuxInvocationObserver, (report: TmuxInvocationReport) => void>
>;
type _InvocationReportDelivery = Expect<Equal<TmuxInvocationReport["delivery"], DeliveryStatus>>;
type _InvocationReportDuration = Expect<Equal<TmuxInvocationReport["durationMs"], number>>;
type _InvocationReportExit = Expect<Equal<TmuxInvocationReport["exitCode"], number | undefined>>;
type _SessionRef = Expect<
  Equal<
    SessionRef,
    {
      readonly connection: ConnectionAlias;
      readonly epoch: DaemonEpoch;
      readonly id: SessionId;
      readonly kind: "session";
    }
  >
>;
type _WindowRef = Expect<
  Equal<
    WindowRef,
    {
      readonly connection: ConnectionAlias;
      readonly epoch: DaemonEpoch;
      readonly id: WindowId;
      readonly kind: "window";
    }
  >
>;
type _PaneRef = Expect<
  Equal<
    PaneRef,
    {
      readonly connection: ConnectionAlias;
      readonly epoch: DaemonEpoch;
      readonly id: PaneId;
      readonly kind: "pane";
    }
  >
>;
type _ResizeFlags = Expect<
  Equal<
    typeof RESIZE_ADJUSTMENT_DIRECTION_FLAG_MAP,
    Readonly<Record<ResizeAdjustmentDirection, string>>
  >
>;
type _WindowFlags = Expect<
  Equal<typeof WINDOW_DIRECTION_FLAG_MAP, Readonly<Record<WindowDirection, string>>>
>;
type _PaneFlags = Expect<
  Equal<typeof PANE_DIRECTION_FLAG_MAP, Readonly<Record<PaneDirection, readonly string[]>>>
>;
type _OptionFlags = Expect<
  Equal<typeof OPTION_SCOPE_FLAG_MAP, Readonly<Record<OptionScope, string>>>
>;
type _HookFlags = Expect<Equal<typeof HOOK_SCOPE_FLAG_MAP, Readonly<Record<OptionScope, string>>>>;
type _HookScope = Expect<Equal<HookScope, OptionScope>>;
type _OptionScope = Expect<Equal<OptionScope, "pane" | "server" | "session" | "window">>;
type _RootCommandOptions = Expect<Equal<RootCommandOptions, CommandOptions>>;
type _RootJoinOptions = Expect<Equal<RootJoinOptions, JoinOptions>>;
type _RootOptionScope = Expect<Equal<RootOptionScopeType, OptionScope>>;
type _RootSetOptionOptions = Expect<Equal<RootSetOptionOptions, SetOptionOptions>>;
type _SafeIntegerGuard = Expect<
  Equal<typeof isSafeInteger, (value: unknown) => value is SafeInteger>
>;
type _SafeIntegerProof = Expect<Equal<typeof safeInteger, (value: number) => SafeInteger>>;
type _RootSafeInteger = Expect<Equal<RootSafeInteger, SafeInteger>>;
type _RootSafeIntegerGuard = Expect<Equal<typeof rootIsSafeInteger, typeof isSafeInteger>>;
type _RootSafeIntegerProof = Expect<Equal<typeof rootSafeInteger, typeof safeInteger>>;
type _RootSplitCellSize = Expect<Equal<RootSplitCellSize, SplitCellSize>>;
type _RootSplitPercentage = Expect<Equal<RootSplitPercentage, SplitPercentage>>;
type _RootSplitSize = Expect<Equal<RootSplitSize, SplitSize>>;
type _RootSplitSizeGuard = Expect<Equal<typeof rootIsSplitSize, typeof isSplitSize>>;
type _RootSplitSizeProof = Expect<Equal<typeof rootSplitSize, typeof splitSize>>;

export type {
  _CommandOutcomeKeys,
  _DeliveryStatus,
  _ExceptionNamespace,
  _HookScope,
  _OperationStatus,
  _OptionScope,
  _PaneFlags,
  _PaneRef,
  _ResizeFlags,
  _RootOptionScope,
  _RootCommandOptions,
  _RootJoinOptions,
  _RootSetOptionOptions,
  _RootSafeInteger,
  _RootSafeIntegerGuard,
  _RootSafeIntegerProof,
  _RootSplitCellSize,
  _RootSplitPercentage,
  _RootSplitSize,
  _RootSplitSizeGuard,
  _RootSplitSizeProof,
  _SafeIntegerGuard,
  _SafeIntegerProof,
  _SessionRef,
  _WindowFlags,
  _WindowRef,
  _OptionFlags,
  _HookFlags,
};

// `code` is a union of every value it can hold, so a comparison against a name
// this package does not have is a type error rather than a branch that never
// runs. The literal-per-class alternative is not available: the hierarchy is
// three deep in places, and a literal on the parent makes the child's
// declaration an illegal override.
declare const waitTimeout: WaitTimeoutError;
const matchesCode: boolean = waitTimeout.code === "WaitTimeoutError";
// @ts-expect-error no error in this package is named this.
const typoInCode: boolean = waitTimeout.code === "WaitTimeoutErrro";
const anyCode: LibTmuxErrorCode = "TmuxCommandError";
void matchesCode;
void typoInCode;
void anyCode;
