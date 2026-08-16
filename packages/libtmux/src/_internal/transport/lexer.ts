/**
 * Turning an argv back into something tmux's own lexer will read.
 *
 * Two places need it: a control connection writes commands as text, and an
 * `if-shell` branch is a string tmux parses when the branch is taken. Both go
 * through one implementation, because a quoting bug in either is a command
 * injection into tmux.
 */

/**
 * Quote one argument for tmux's command lexer.
 *
 * An argument holding a space — a socket path, a window name, a `send-keys`
 * payload — lexes as several unless it arrives quoted. The lexer accepts POSIX
 * single-quoting, including the `'\''` idiom for an embedded quote, and treats
 * everything else inside single quotes literally: no format expansion, no
 * backslash escapes, no `;` splitting the command.
 */
function quoteArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** One tmux command, quoted argument by argument. */
export function quoteCommand(argv: readonly string[]): string {
  return argv.map(quoteArgument).join(" ");
}
