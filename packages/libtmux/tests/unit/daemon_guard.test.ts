import { describe, expect, test } from "bun:test";

import {
  carriesTmuxId,
  daemonCondition,
  guardedArgv,
  refusedByGuard,
} from "../../src/_internal/transport/daemon_guard.js";

const encoder = new TextEncoder();
const daemon = { pid: "4242", startTime: "1700000000" };

describe("daemon guard", () => {
  test("recognises the argv shapes a restart makes dangerous", () => {
    expect(carriesTmuxId(["kill-pane", "-t", "%3"])).toBe(true);
    expect(carriesTmuxId(["kill-window", "-t", "@7"])).toBe(true);
    expect(carriesTmuxId(["kill-session", "-t", "$0"])).toBe(true);
    // Sources carry ids too, and a guard reading only `-t` would miss them.
    expect(carriesTmuxId(["swap-pane", "-s", "%1", "-t", "%2"])).toBe(true);
    expect(carriesTmuxId(["link-window", "-s", "@4", "-t", "other:9"])).toBe(true);

    // Named targets survive a restart as names, so they need no guard.
    expect(carriesTmuxId(["kill-session", "-t", "work"])).toBe(false);
    expect(carriesTmuxId(["list-sessions"])).toBe(false);
    expect(carriesTmuxId(["new-window", "-t", "work:1"])).toBe(false);
  });

  test("pins pid and start time together, because pids are reused", () => {
    expect(daemonCondition(daemon)).toBe("#{==:#{pid}/#{start_time},4242/1700000000}");
  });

  test("keeps the server flags outside the wrapper and quotes the command inside", () => {
    expect(guardedArgv(["-S", "/tmp/ltx s"], ["kill-pane", "-t", "%3"], daemon)).toEqual([
      "-S",
      "/tmp/ltx s",
      "if-shell",
      "-F",
      "#{==:#{pid}/#{start_time},4242/1700000000}",
      "'kill-pane' '-t' '%3'",
      "'list-windows' '-t' 'libtmux-daemon-restarted'",
    ]);
  });

  test("a payload that is tmux syntax stays a payload", () => {
    // Single-quoting is literal to tmux's lexer, so none of this can start a
    // second command, expand a format, or escape the branch it is in.
    const payload = `a b;kill-server "c" 'd' #{pane_id} \\e`;
    const argv = guardedArgv([], ["send-keys", "-t", "%1", "-l", payload], daemon);

    expect(argv.at(-2)).toBe(
      `'send-keys' '-t' '%1' '-l' 'a b;kill-server "c" '\\''d'\\'' #{pane_id} \\e'`,
    );
  });

  test("tells the guard refusing from the command failing", () => {
    expect(refusedByGuard(1, encoder.encode("can't find session: libtmux-daemon-restarted"))).toBe(
      true,
    );
    expect(refusedByGuard(1, encoder.encode("can't find pane: %99"))).toBe(false);
    // A zero exit is the command having run, whatever it printed.
    expect(refusedByGuard(0, encoder.encode("libtmux-daemon-restarted"))).toBe(false);
  });
});
