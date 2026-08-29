/**
 * What a caller-supplied session or window name may be.
 *
 * tmux does not carry one name identically across the range this package
 * supports. Asking for `a:b` gets a session called `a_b` on 3.2a through 3.6b,
 * an `invalid session name` failure on 3.7, and a session called `a:b` on 3.7a
 * and later. The first is the damaging one: nothing fails, and the handle comes
 * back under a name the caller never asked for.
 *
 * A name is refused unless every supported server would store it unchanged.
 * `:` and `.` are the target delimiters, which is why tmux treats them
 * specially and why a name holding one cannot be addressed as a target on any
 * version. Control bytes and DEL are rejected from 3.7 and stored raw before
 * it. An unpaired surrogate is not encodable and would reach tmux as U+FFFD.
 *
 * Python libtmux refuses the same delimiters through `session_check_name`.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point.
const FORBIDDEN = /[.:\u0000-\u001f\u007f]/u;

/** Whether every supported server would store this name unchanged. */
export function isName(value: string): boolean {
  return value !== "" && value.isWellFormed() && !FORBIDDEN.test(value);
}

export function assertName(kind: "session" | "window", value: string): string {
  if (value === "") throw new TypeError(`${kind} name must not be empty`);
  if (!value.isWellFormed()) {
    throw new TypeError(`${kind} name must not hold an unpaired surrogate`);
  }
  if (FORBIDDEN.test(value)) {
    throw new TypeError(
      `${kind} name must not hold ":", ".", a control character, or DEL: ${JSON.stringify(value)}`,
    );
  }
  return value;
}
