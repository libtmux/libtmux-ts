/**
 * A tmux that reaches no server. It appends argv, the names of the variables that choose one
 * and whether TMUX_TMPDIR is the sandbox to `trace` beside it, never a value.
 */

export const RECORDING_TMUX = `#!/bin/sh
{
  printf 'argv'
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
  for name in TMUX TMUX_PANE TMUX_TMPDIR LIBTMUX_SOCKET LIBTMUX_SOCKET_PATH; do
    eval "[ \\"\\\${$name+set}\\" = set ]" && printf 'set\\t%s\\n' "$name"
  done
  if [ -n "\${LIBTMUX_TEST_SANDBOX:-}" ] && [ "\${TMUX_TMPDIR:-}" = "$LIBTMUX_TEST_SANDBOX" ]; then
    printf 'tmpdir-is-sandbox\\n'
  fi
  printf -- '--\\n'
} >> "$(dirname "$0")/trace"
exit 0
`;

export interface Call {
  readonly argv: readonly string[];
  readonly set: readonly string[];
  readonly tmpdirIsSandbox: boolean;
}

export function parseCalls(trace: string): readonly Call[] {
  return trace
    .split("--\n")
    .filter((record) => record !== "")
    .map((record) => {
      const [first = "", ...rest] = record.split("\n").filter((line) => line !== "");
      return {
        argv: first.split("\t").slice(1),
        set: rest.filter((line) => line.startsWith("set\t")).map((line) => line.slice(4)),
        tmpdirIsSandbox: rest.includes("tmpdir-is-sandbox"),
      };
    });
}
