/**
 * What a caller-supplied session or window name may be.
 *
 * Refused unless every supported server stores it unchanged: tmux rewrites a
 * delimiter to `_` before 3.7, fails on 3.7, and keeps it after, so the same
 * name means three things. `:` and `.` also split a target, which leaves a
 * name holding one unaddressable by name on every version. Python libtmux
 * refuses the same two through `session_check_name`.
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
