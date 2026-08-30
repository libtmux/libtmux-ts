import { describe, expect, test } from "bun:test";

import { carriesTmuxId, daemonCondition } from "../../src/_internal/transport/daemon_guard.js";
// Through the public entry an engine author imports, not the internal path,
// so this fails if the export is dropped from `libtmux/engine`.
import { guardRequest } from "../../src/engine.js";
import type { TmuxInvocationRequest } from "../../src/engine.js";

const encoder = new TextEncoder();
const daemon = { pid: "4242", startTime: "1700000000" };
const refusalCommand = /^'libtmux-daemon-restarted-[0-9a-f]{32}'$/u;

describe("daemon guard", () => {
  test("recognises the argv shapes a restart makes dangerous", () => {
    expect(carriesTmuxId(["kill-pane", "-t", "%3"])).toBe(true);
    expect(carriesTmuxId(["kill-window", "-t", "@7"])).toBe(true);
    expect(carriesTmuxId(["kill-session", "-t", "$0"])).toBe(true);
    expect(carriesTmuxId(["unlink-window", "-t", "$0:7"])).toBe(true);
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

  test("guards a whole request, which is what an engine is handed", () => {
    // An engine receives requests, not argv, and the built-in transport is the
    // only thing that knew how to turn the guard on one into the wrapper tmux
    // enforces. Published so an implementer inherits restart safety instead of
    // reimplementing `if-shell -F`, the unique refusal command, and the stderr
    // that tells a refusal from a failure.
    // Global flags carry their value joined, which is what makes "the
    // subcommand starts at the first argument without a leading dash" exact.
    const guarded = guardRequest({
      commands: [
        ["kill-pane", "-t", "%3"],
        ["display-message", "-p", "done"],
      ],
      daemonGuard: daemon,
      executable: "tmux",
      globalArgs: ["-S/tmp/ltx"],
    });

    const [name, flag, condition, chain, refusal] = guarded.request.commands[0];
    expect(guarded.request.globalArgs).toEqual(["-S/tmp/ltx"]);
    expect({ chain, condition, flag, name }).toEqual({
      chain: "'kill-pane' '-t' '%3' ; 'display-message' '-p' 'done'",
      condition: daemonCondition(daemon),
      flag: "-F",
      name: "if-shell",
    });
    expect(refusal).toMatch(refusalCommand);
  });

  test("leaves an unguarded request alone and rejects guarded stdin", () => {
    const unguarded: TmuxInvocationRequest = {
      commands: [["list-panes"]],
      executable: "tmux",
      globalArgs: ["-S/tmp/ltx"],
    };
    const prepared = guardRequest(unguarded);
    expect(prepared.request).toBe(unguarded);
    expect(prepared.refusedBy(1, encoder.encode("anything"))).toBe(false);

    const piped: TmuxInvocationRequest = {
      commands: [["kill-pane", "-t", "%1"]],
      daemonGuard: daemon,
      executable: "tmux",
      globalArgs: [],
      stdin: encoder.encode("hi"),
    };
    expect(() => guardRequest(piped)).toThrow(/stdin/u);
  });

  test("binds refusal recognition to this request's nonce", () => {
    const guarded = guardRequest({
      commands: [["kill-pane", "-t", "%3"]],
      daemonGuard: daemon,
      executable: "tmux",
      globalArgs: [],
    });
    const quoted = guarded.request.commands[0].at(-1);
    if (quoted === undefined) throw new Error("missing refusal command");
    const command = quoted.slice(1, -1);
    const refusal = `unknown command: ${command}`;
    const otherCommand = `${command.slice(0, -1)}${command.endsWith("0") ? "1" : "0"}`;

    expect(guarded.refusedBy(1, encoder.encode(refusal))).toBe(true);
    expect(guarded.refusedBy(1, encoder.encode(`unknown command: ${otherCommand}`))).toBe(false);
    expect(guarded.refusedBy(1, encoder.encode(`prefix ${refusal}`))).toBe(false);
    expect(guarded.refusedBy(1, encoder.encode("can't find pane: %99"))).toBe(false);
    expect(guarded.refusedBy(0, encoder.encode(refusal))).toBe(false);
  });
});
