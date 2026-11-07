export { Client } from "./client.js";
export { Pane, type PanePlans } from "./pane.js";
export { Program } from "./program.js";
export { Server, type DaemonIdentity, type ServerOptions } from "./server.js";
export { Session, type SessionPlans } from "./session.js";
export { Window, type WindowPlans } from "./window.js";

export {
  compileBoundedRegex,
  decodeWhereDocument,
  encodeWhereDocument,
  type ClientWhere,
  type PaneWhere,
  type RegexCriteriaData,
  type Selection,
  type SessionWhere,
  type WhereDocumentV1,
  type WhereOf,
  type WindowWhere,
} from "./selection.js";

export type {
  AbortLike,
  CaptureOptions,
  ConnectOptions,
  ConnectionOptions,
  CmdOptions,
  ConnectedServer,
  ChooseTreeOptions,
  CommandWaitOptions,
  EnvironmentScope,
  EnvironmentValue,
  HookScope,
  IfShellOptions,
  JoinOptions,
  MenuEntry,
  MenuItem,
  MoveWindowOptions,
  PlannedOperation,
  NewSessionOptions,
  NewWindowOptions,
  PopupOptions,
  ProgramExit,
  ProgramPlacement,
  ProgramResult,
  ProgramStreamOptions,
  ProgramWaitOptions,
  RespawnOptions,
  ResizeOptions,
  ResizeWindowOptions,
  RunOptions,
  RunShellOptions,
  SaveBufferOptions,
  SendKeysOptions,
  ServerSnapshot,
  SnapshotOptions,
  SetEnvironmentOptions,
  SetHookOptions,
  SetOptionOptions,
  SplitCellSize,
  SplitOptions,
  SplitPercentage,
  SplitSize,
  SpawnOptions,
  TmuxClientDetachedEvent,
  TmuxClientSessionChangedEvent,
  TmuxEvent,
  TmuxEventStream,
  TmuxExitEvent,
  TmuxLayoutChangeEvent,
  TmuxMessageEvent,
  TmuxOutputEvent,
  TmuxPaneFlowEvent,
  TmuxPaneModeChangedEvent,
  TmuxPasteBufferEvent,
  TmuxReconnectedEvent,
  TmuxReconnectingEvent,
  TmuxSessionEvent,
  TmuxSessionWindowChangedEvent,
  TmuxSessionsChangedEvent,
  TmuxUnknownEvent,
  TmuxVersion,
  TmuxWindowLifecycleEvent,
  TmuxWindowPaneChangedEvent,
  TmuxWindowRenamedEvent,
  WatchOptions,
  WindowTarget,
} from "./types.js";
export { isSplitSize, isTmuxName, splitSize } from "./types.js";

export {
  LibTmuxError,
  type LibTmuxErrorCode,
  MultipleMatchesError,
  MultipleObjectsError,
  NoMatchError,
  ObjectNotFoundError,
  QueryValidationError,
  TmuxCommandError,
  TmuxServerRestartedError,
  TmuxTransportError,
  type TmuxTransportErrorKind,
  OutputLostError,
  ProgramStartError,
  type ProgramStartFailure,
  ServerNotLocalError,
  StreamLimitError,
  VersionTooLowError,
  WaitTimeoutError,
} from "./errors.js";
export type {
  CommandOptions,
  DeliveryStatus,
  PaneId,
  PaneIdInput,
  SafeInteger,
  SessionId,
  SessionIdInput,
  TmuxInvocationObserver,
  TmuxInvocationReport,
  TmuxId,
  TmuxIdInput,
  TmuxIdKind,
  WindowId,
  WindowIdInput,
} from "./common.js";
export { assertSupportedTmux, isSafeInteger, MINIMUM_TMUX, safeInteger } from "./common.js";
export {
  OptionScope,
  PaneDirection,
  ResizeAdjustmentDirection,
  WindowDirection,
} from "./constants.js";

/** @deprecated Use {@link LibTmuxError}. Exported in 0.1.x; no removal is scheduled. */
export { LibTmuxException } from "./errors.js";
/** @deprecated Use {@link ObjectNotFoundError}. Exported in 0.1.x; no removal is scheduled. */
export { ObjectDoesNotExist } from "./errors.js";
/** @deprecated Use {@link MultipleObjectsError}. Exported in 0.1.x; no removal is scheduled. */
export { MultipleObjectsReturned } from "./errors.js";
/** @deprecated Use {@link VersionTooLowError}. Exported in 0.1.x; no removal is scheduled. */
export { VersionTooLow } from "./errors.js";
/** @deprecated Use {@link WaitTimeoutError}. Exported in 0.1.x; no removal is scheduled. */
export { WaitTimeout } from "./errors.js";
/** @deprecated Use {@link TmuxServerRestartedError}. Exported in 0.1.x; no removal is scheduled. */
export { TmuxServerRestarted } from "./errors.js";
