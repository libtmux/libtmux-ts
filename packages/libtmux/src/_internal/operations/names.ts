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

/**
 * What a subscription name may be.
 *
 * `refresh-client -B` reads `name:what:format`, so a colon in the name shifts
 * every field after it; a name on its own is the unsubscribe form, and one
 * carrying a single colon is discarded without a reply
 * (`cmd_refresh_client_update_subscription`). tmux writes the name back into
 * `%subscription-changed` unescaped, where a space would make the field
 * boundaries ambiguous. Refused here rather than sent, because tmux answers
 * all three the same way: silently.
 */
export function assertSubscriptionName(value: string): string {
  if (value === "") throw new TypeError("subscription name must not be empty");
  if (!value.isWellFormed()) {
    throw new TypeError("subscription name must not hold an unpaired surrogate");
  }
  if (/[\s:]/u.test(value) || FORBIDDEN.test(value)) {
    throw new TypeError(
      `subscription name must not hold ":", whitespace, or a control character: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * What a subscribed format may be.
 *
 * The report is one line, so a newline in the format produces further lines
 * that cannot be attributed to it. This refuses a literal one; a format whose
 * expansion contains a newline is the caller's to avoid.
 */
export function assertSubscriptionFormat(value: string): string {
  if (value === "") throw new TypeError("subscription format must not be empty");
  if (!value.isWellFormed()) {
    throw new TypeError("subscription format must not hold an unpaired surrogate");
  }
  if (/[\n\r]/u.test(value)) {
    throw new TypeError("subscription format must not hold a line break");
  }
  return value;
}
