import { describe, expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { effectiveWaitMs, resolvePolicy, tierAllows } from "../src/policy.js";
import { createTmuxMcpServer, serverFromEnvironment } from "../src/server.js";
import { describeStartup } from "../src/startup.js";

describe("policy", () => {
  test("rejects malformed embedded policy before registering tools", () => {
    const base = resolvePolicy({});
    const malformed = [
      ["safety", ["destructive"]],
      ["blockingWaitMaxMs", 2_147_483_648],
      ["liveEnabled", "false"],
      ["maxResultLines", 0],
      ["tools", []],
    ] as const;

    for (const [field, value] of malformed) {
      const policy = { ...base, [field]: value } as unknown as typeof base;
      expect(() => createTmuxMcpServer(new Server(), { policy })).toThrow(`policy.${field}`);
    }
  });

  test("clamps a blocking wait to the ceiling and reports the ceiling", () => {
    const policy = resolvePolicy({});
    expect(effectiveWaitMs(policy, 999_999_999)).toBe(policy.blockingWaitMaxMs);
  });

  test("defaults a wait to the blocking ceiling", () => {
    const policy = resolvePolicy({});
    expect(effectiveWaitMs(policy, undefined)).toBe(policy.blockingWaitMaxMs);
  });

  test("keeps an operator override inside bounds that leave it a ceiling", () => {
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "1" }).blockingWaitMaxMs).toBe(1_000);
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "99999999" }).blockingWaitMaxMs).toBe(120_000);
  });

  test("falls back rather than refusing to start on an unparseable value", () => {
    // An MCP server that refuses to start is one whose message nobody reads.
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "soon" }).blockingWaitMaxMs).toBe(30_000);
  });

  test("requires an exact positive decimal safe integer", () => {
    for (const given of ["0", "-1", "42junk", "1.5", "1e6", "+42", " 42", "9007199254740992"]) {
      expect(resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: given }).commandTimeoutMs).toBe(
        30_000,
      );
    }
    expect(resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "42" }).commandTimeoutMs).toBe(42);
  });

  test("caps positive command deadlines at JavaScript's timer range", () => {
    const environment = { LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "2147483648" };

    expect(resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "2147483647" }).commandTimeoutMs).toBe(
      2_147_483_647,
    );
    expect(resolvePolicy(environment).commandTimeoutMs).toBe(2_147_483_647);
    expect(
      resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "9007199254740991" }).commandTimeoutMs,
    ).toBe(2_147_483_647);
    expect(() => serverFromEnvironment(environment)).not.toThrow();
  });

  test("offers the default tier when nobody chose one", () => {
    expect(resolvePolicy({}).safety).toBe("readonly");
  });

  test("reads a tier by name, including the way readonly is usually mistyped", () => {
    expect(resolvePolicy({ LIBTMUX_SAFETY: "readonly" }).safety).toBe("readonly");
    expect(resolvePolicy({ LIBTMUX_SAFETY: "read-only" }).safety).toBe("readonly");
    expect(resolvePolicy({ LIBTMUX_SAFETY: " Destructive " }).safety).toBe("destructive");
  });

  test("narrows to readonly on a tier it does not recognise, rather than widening", () => {
    // Falling back is right — the variable is read from wherever the process
    // was started, and refusing to launch hides the reason. Falling back
    // *upward* is not: it hands an agent the tools an operator was trying to
    // withhold, and the mistake looks exactly like a working configuration.
    for (const given of ["read only", "read_only", "ro", "yolo", ""]) {
      expect(resolvePolicy({ LIBTMUX_SAFETY: given }).safety).toBe("readonly");
    }
  });

  test("orders the safety tiers so a lower one hides a higher one's tools", () => {
    expect(tierAllows("readonly", "mutating")).toBe(false);
    expect(tierAllows("mutating", "readonly")).toBe(true);
    expect(tierAllows("mutating", "destructive")).toBe(false);
    expect(tierAllows("destructive", "destructive")).toBe(true);
    expect(tierAllows(["destructive"] as unknown as "destructive", "destructive")).toBe(false);
  });
});

describe("startup line", () => {
  test("names the tier in force, which is the setting most worth mistyping", () => {
    const line = describeStartup({
      caller: { paneId: undefined, serverPid: undefined, socketPath: undefined },
      policy: resolvePolicy({ LIBTMUX_SAFETY: "readonly" }),
      server: new Server({ socketName: "agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("readonly");
    expect(line).toContain("1.2.3");
  });

  test("names the socket, so two servers in one log can be told apart", () => {
    const line = describeStartup({
      caller: { paneId: undefined, serverPid: undefined, socketPath: undefined },
      policy: resolvePolicy({}),
      server: new Server({ socketPath: "/tmp/libtmux-rs-dev/agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("/tmp/libtmux-rs-dev/agents");
  });

  test("reports an allowlist without counting requested names as offered tools", () => {
    const line = describeStartup({
      caller: { paneId: undefined, serverPid: undefined, socketPath: undefined },
      policy: resolvePolicy({
        LIBTMUX_MCP_TOOLS: "list_panes, kill_session",
        LIBTMUX_SAFETY: "readonly",
      }),
      server: new Server({ socketName: "agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("tool allowlist set");
    expect(line).not.toContain("2 tools allowed");
  });

  test("names the caller's pane, since the tools that would destroy it refuse", () => {
    const line = describeStartup({
      caller: { paneId: "%7", serverPid: "4242", socketPath: "/tmp/x" },
      policy: resolvePolicy({}),
      server: new Server({ socketName: "agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("%7");
  });

  test("is one line, because a startup banner nobody can scan is not read", () => {
    const line = describeStartup({
      caller: { paneId: "%7", serverPid: "4242", socketPath: "/tmp/x" },
      policy: resolvePolicy({ LIBTMUX_MCP_TOOLS: "list_panes" }),
      server: new Server({ socketPath: "/tmp/libtmux-rs-dev/agents" }),
      version: "1.2.3",
    });
    expect(line).not.toContain("\n");
  });
});

describe("tool allowlist", () => {
  test("distinguishes an unset allowlist from an empty one", () => {
    expect(resolvePolicy({ LIBTMUX_MCP_TOOLS: "list_panes, capture_pane" }).tools).toEqual(
      new Set(["list_panes", "capture_pane"]),
    );
    expect(resolvePolicy({ LIBTMUX_MCP_TOOLS: "" }).tools).toEqual(new Set());
    expect(resolvePolicy({ LIBTMUX_MCP_TOOLS: " , " }).tools).toEqual(new Set());
    expect(resolvePolicy({}).tools).toBeUndefined();
  });
});
