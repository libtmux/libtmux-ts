// Every symbol here is re-exported individually, rather than through one
// `export *`, because TypeScript does not propagate a `@deprecated` tag
// through a star re-export: an editor would show no warning for any of
// them. Keep this list in the order errors.ts declares them.

/** @deprecated Import from `libtmux/errors` instead. */
export type { Query } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export type { TmuxCommandFailureOptions } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { LibTmuxError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export type { TmuxTransportErrorKind } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { TmuxTransportError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export type { TmuxTransportErrorOptions } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { ObjectNotFoundError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { MultipleObjectsError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { TmuxObjectNotFoundError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { VersionTooLowError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { WaitTimeoutError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { NoMatchError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { MultipleMatchesError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export type { QueryValidationErrorCode } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { QueryValidationError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { TmuxServerRestartedError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. */
export { TmuxCommandError } from "./errors.js";
/** @deprecated Use `LibTmuxError` from `libtmux/errors`. */
export { LibTmuxException } from "./errors.js";
/** @deprecated Use `ObjectNotFoundError` from `libtmux/errors`. */
export { ObjectDoesNotExist } from "./errors.js";
/** @deprecated Use `MultipleObjectsError` from `libtmux/errors`. */
export { MultipleObjectsReturned } from "./errors.js";
/** @deprecated Use `TmuxObjectNotFoundError` from `libtmux/errors`. */
export { TmuxObjectDoesNotExist } from "./errors.js";
/** @deprecated Use `VersionTooLowError` from `libtmux/errors`. */
export { VersionTooLow } from "./errors.js";
/** @deprecated Use `WaitTimeoutError` from `libtmux/errors`. */
export { WaitTimeout } from "./errors.js";
/** @deprecated Use `TmuxServerRestartedError` from `libtmux/errors`. */
export { TmuxServerRestarted } from "./errors.js";
