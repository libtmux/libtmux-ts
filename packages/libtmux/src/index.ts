export { Client } from "./client.js";
export { Pane, type PanePlans } from "./pane.js";
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
  RespawnOptions,
  ResizeOptions,
  ResizeWindowOptions,
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
export { isSafeInteger, safeInteger } from "./common.js";
export {
  OptionScope,
  PaneDirection,
  ResizeAdjustmentDirection,
  WindowDirection,
} from "./constants.js";

/** @deprecated Use {@link LibTmuxError}. Removed at `0.1.0`. */
export { LibTmuxException } from "./errors.js";
/** @deprecated Use {@link ObjectNotFoundError}. Removed at `0.1.0`. */
export { ObjectDoesNotExist } from "./errors.js";
/** @deprecated Use {@link MultipleObjectsError}. Removed at `0.1.0`. */
export { MultipleObjectsReturned } from "./errors.js";
/** @deprecated Use {@link VersionTooLowError}. Removed at `0.1.0`. */
export { VersionTooLow } from "./errors.js";
/** @deprecated Use {@link WaitTimeoutError}. Removed at `0.1.0`. */
export { WaitTimeout } from "./errors.js";
/** @deprecated Use {@link TmuxServerRestartedError}. Removed at `0.1.0`. */
export { TmuxServerRestarted } from "./errors.js";
