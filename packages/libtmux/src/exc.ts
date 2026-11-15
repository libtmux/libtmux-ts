// Every symbol here is re-exported individually, rather than through one
// `export *`, because TypeScript does not propagate a `@deprecated` tag
// through a star re-export: an editor would show no warning for any of
// them. Keep this list in the order errors.ts declares them.

/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export type { Query } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export type { TmuxCommandFailureOptions } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { LibTmuxError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export type { TmuxTransportErrorKind } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { TmuxTransportError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export type { TmuxTransportErrorOptions } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { ObjectNotFoundError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { MultipleObjectsError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { TmuxObjectNotFoundError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { VersionTooLowError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { WaitTimeoutError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { NoMatchError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { MultipleMatchesError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export type { QueryValidationReason } from "./errors.js";
/** @deprecated Use `QueryValidationReason` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export type { QueryValidationErrorCode } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { QueryValidationError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { TmuxServerRestartedError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Exported in 0.1.x; no removal is scheduled. */
export { TmuxCommandError } from "./errors.js";
/** @deprecated Use `LibTmuxError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { LibTmuxException } from "./errors.js";
/** @deprecated Use `ObjectNotFoundError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { ObjectDoesNotExist } from "./errors.js";
/** @deprecated Use `MultipleObjectsError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { MultipleObjectsReturned } from "./errors.js";
/** @deprecated Use `TmuxObjectNotFoundError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { TmuxObjectDoesNotExist } from "./errors.js";
/** @deprecated Use `VersionTooLowError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { VersionTooLow } from "./errors.js";
/** @deprecated Use `WaitTimeoutError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { WaitTimeout } from "./errors.js";
/** @deprecated Use `TmuxServerRestartedError` from `libtmux/errors`. Exported in 0.1.x; no removal is scheduled. */
export { TmuxServerRestarted } from "./errors.js";
