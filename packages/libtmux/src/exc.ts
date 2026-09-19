// Every symbol here is re-exported individually, rather than through one
// `export *`, because TypeScript does not propagate a `@deprecated` tag
// through a star re-export: an editor would show no warning for any of
// them. Keep this list in the order errors.ts declares them.

/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export type { Query } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export type { TmuxCommandFailureOptions } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { LibTmuxError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export type { TmuxTransportErrorKind } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { TmuxTransportError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export type { TmuxTransportErrorOptions } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { ObjectNotFoundError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { MultipleObjectsError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { TmuxObjectNotFoundError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { VersionTooLowError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { WaitTimeoutError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { NoMatchError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { MultipleMatchesError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export type { QueryValidationReason } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { QueryValidationError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { TmuxServerRestartedError } from "./errors.js";
/** @deprecated Import from `libtmux/errors` instead. Removed at `0.1.0`. */
export { TmuxCommandError } from "./errors.js";
/** @deprecated Use `LibTmuxError` from `libtmux/errors`. Removed at `0.1.0`. */
export { LibTmuxException } from "./errors.js";
/** @deprecated Use `ObjectNotFoundError` from `libtmux/errors`. Removed at `0.1.0`. */
export { ObjectDoesNotExist } from "./errors.js";
/** @deprecated Use `MultipleObjectsError` from `libtmux/errors`. Removed at `0.1.0`. */
export { MultipleObjectsReturned } from "./errors.js";
/** @deprecated Use `TmuxObjectNotFoundError` from `libtmux/errors`. Removed at `0.1.0`. */
export { TmuxObjectDoesNotExist } from "./errors.js";
/** @deprecated Use `VersionTooLowError` from `libtmux/errors`. Removed at `0.1.0`. */
export { VersionTooLow } from "./errors.js";
/** @deprecated Use `WaitTimeoutError` from `libtmux/errors`. Removed at `0.1.0`. */
export { WaitTimeout } from "./errors.js";
/** @deprecated Use `TmuxServerRestartedError` from `libtmux/errors`. Removed at `0.1.0`. */
export { TmuxServerRestarted } from "./errors.js";
