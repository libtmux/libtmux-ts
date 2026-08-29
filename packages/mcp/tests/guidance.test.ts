import { describe, expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { readCallerEnvironment } from "../src/caller.js";
import { describeUnreachable } from "../src/context.js";
import { buildInstructions, instructionsBudget } from "../src/instructions.js";
import { resolvePolicy } from "../src/policy.js";

describe("unreachable server", () => {
  test("names the variable an operator set, because the agent did not set it", () => {
    const byPath = describeUnreachable(
      new Server({ socketPath: "/tmp/ltx-gone" }),
      "cannot reach tmux: no server running on /tmp/ltx-gone",
    );
    expect(byPath).toContain("LIBTMUX_SOCKET_PATH=/tmp/ltx-gone");
    // The recovery matters more than the reason: an agent told only that
    // something failed reports "unavailable" and stops, which is what one did.
    expect(byPath).toContain("new_session");
    expect(byPath).toContain("report it rather than retrying");

    expect(describeUnreachable(new Server({ socketName: "agent" }), "cannot reach tmux")).toContain(
      "LIBTMUX_SOCKET_NAME=agent",
    );
    // Nothing set at all, so there is no knob to send anyone to. The wording
    // covers the executable as well as the socket now, since a bad binary and
    // a bad socket reach here identically.
    expect(describeUnreachable(new Server(), "cannot reach tmux")).toContain("nothing configured");
  });
});

describe("unreachable guidance", () => {
  test("names the executable when that is what was configured", () => {
    // A bad binary and a bad socket both surface as "cannot reach tmux". This
    // text is the only channel to the human who can fix either, so naming the
    // healthy one sends them to check something that is fine.
    const said = describeUnreachable(
      new Server({ socketName: "fine", tmuxBin: "/nonexistent/tmux" }),
      "cannot reach tmux: could not run /nonexistent/tmux (ENOENT)",
    );
    expect(said).toContain("LIBTMUX_TMUX_BIN=/nonexistent/tmux");
    expect(said).toContain("LIBTMUX_SOCKET_NAME=fine");
  });

  test("says nothing about an executable nobody chose", () => {
    // The quiet half: naming a default nobody set is noise, and would make the
    // line say something was configured when it was not.
    const said = describeUnreachable(
      new Server({ socketName: "fine" }),
      "cannot reach tmux: error connecting to /tmp/tmux-1000/fine",
    );
    expect(said).not.toContain("LIBTMUX_TMUX_BIN");
    expect(said).toContain("LIBTMUX_SOCKET_NAME=fine");
  });
});

describe("caller environment", () => {
  test("reads the pane from TMUX_PANE and the daemon from TMUX", () => {
    const caller = readCallerEnvironment({
      TMUX: "/tmp/tmux-1000/default,48188,10",
      TMUX_PANE: "%7",
    });
    expect(caller).toEqual({
      paneId: "%7",
      serverPid: "48188",
      socketPath: "/tmp/tmux-1000/default",
    });
  });

  test("reports nothing when the process is not inside tmux", () => {
    expect(readCallerEnvironment({}).paneId).toBeUndefined();
  });

  test("takes the pane from TMUX_PANE even with TMUX absent", () => {
    // The pane is authoritative: TMUX's session index goes stale when a pane
    // moves between sessions, and TMUX_PANE does not.
    expect(readCallerEnvironment({ TMUX_PANE: "%3" }).paneId).toBe("%3");
  });

  test("finds the pid when the socket path itself contains a comma", () => {
    // tmux writes "path,pid,session", so the pid is the second field from the
    // right however many commas the path holds. Reading left to right hands
    // back a fragment of the path as the daemon pid.
    const caller = readCallerEnvironment({ TMUX: "/tmp/run, root/sock,48188,0" });
    expect(caller.serverPid).toBe("48188");
    expect(caller.socketPath).toBe("/tmp/run, root/sock");
  });
});

describe("instructions", () => {
  test("fit the budget with room for the caller context", () => {
    const { limit, used } = instructionsBudget();
    expect(used).toBeLessThan(limit);
  });

  test("name the caller's pane when there is one", () => {
    const text = buildInstructions(resolvePolicy({}), {
      paneId: "%4",
      serverPid: "1",
      socketPath: "/s",
    });
    expect(text).toContain("%4");
    expect(text).toContain("whoami");
  });

  test("keep shared and caller safety guidance under a nonempty allowlist", () => {
    const text = buildInstructions(
      resolvePolicy({ LIBTMUX_MCP_TOOLS: "run_command", LIBTMUX_SAFETY: "mutating" }),
      { paneId: "%4", serverPid: "1", socketPath: "/s" },
    );
    expect(text).toContain("Server > Session > Window > Pane");
    expect(text).toContain("ANTI-TRIGGERS");
    expect(text).toContain("tmux://sessions");
    expect(text).toContain("launched from tmux pane %4");
    expect(text).toContain("only when it belongs to the served tmux server");
    expect(text).toContain("refuses to write to or kill");
    expect(text).not.toContain("Offered mutations");
    expect(text).not.toContain("wait_for_text");
  });

  test("say nothing about a pane when the server runs outside tmux", () => {
    const text = buildInstructions(resolvePolicy({}), {
      paneId: undefined,
      serverPid: undefined,
      socketPath: undefined,
    });
    expect(text).not.toContain("running inside tmux pane");
  });

  test("state the active safety tier, since it decides what is listed", () => {
    expect(buildInstructions(resolvePolicy({ LIBTMUX_SAFETY: "readonly" }))).toContain(
      "Safety: readonly",
    );
  });

  test("does not advertise waits when live connections are disabled", () => {
    const text = buildInstructions(resolvePolicy({ LIBTMUX_MCP_LIVE: "0" }));
    expect(text).toContain("Live streaming is disabled");
    expect(text).not.toContain("wait_for_text");
  });

  test("do not recommend tools when none are enabled", () => {
    const text = buildInstructions(resolvePolicy({ LIBTMUX_MCP_TOOLS: "" }));
    expect(text).toContain("No tools are enabled");
    expect(text).not.toContain("run_command");
  });
});
