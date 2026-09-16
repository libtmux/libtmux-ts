import { describe, expect, test } from "bun:test";

import type {
  CommandRequest,
  CommandTransport,
  RawCommandResult,
} from "../../src/_internal/transport/types.js";
import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { createRuntimeContext } from "../../src/_internal/runtime/context.js";
import { newSession, newWindow, splitWindow } from "../../src/_internal/operations/mutations.js";
import { sendKeys } from "../../src/_internal/operations/pane_io.js";
import { unzoomTarget, zoomPane } from "../../src/_internal/operations/topology.js";
import {
  planKillPaneIfUnshared,
  planNewSession,
  planNewWindow,
  planSplitWindow,
} from "../../src/_internal/operations/plans.js";
import { splitSize } from "../../src/types.js";
import { WindowDirection } from "../../src/constants.js";
import { flattenInvocation } from "../../src/_internal/transport/invocation.js";

/**
 * The tmux command line the lifecycle mutations build.
 *
 * A shell command tmux cannot exec destroys its pane immediately, so an
 * integration test cannot hold one still long enough to look at. What is worth
 * checking about a command beginning with `-` is that it reaches tmux as a
 * command rather than a flag, and that is decided when the arguments are built.
 */

interface Recorder extends CommandTransport {
  readonly requests: CommandRequest[];
}

function recorder(returncode = 1): Recorder {
  const requests: CommandRequest[] = [];
  return {
    requests,
    // Resolving the created object needs a snapshot this fixture does not
    // build, so the call fails after the arguments have been recorded. A call
    // that issues more than one command passes 0, or it never reaches the
    // second.
    execute(request: CommandRequest): Promise<RawCommandResult> {
      requests.push(request);
      return Promise.resolve({
        cmd: [request.executable, ...flattenInvocation(request)],
        returncode,
        signal: null,
        // The transport boundary is bytes; decoding happens above it.
        stderr: new TextEncoder().encode("stopped\n"),
        stdout: new Uint8Array(),
      });
    },
  };
}

function runtimeFor(transport: Recorder) {
  return createRuntimeContext({
    connection: new TmuxConnection({ executable: "tmux", socketName: "mutation-arguments" }),
    connectionAlias: "mutation-arguments" as ConnectionAlias,
    daemonEpoch: 0 as DaemonEpoch,
    transport,
  });
}

async function argumentsFor(
  run: (transport: Recorder) => Promise<unknown>,
): Promise<readonly string[]> {
  const transport = recorder();
  await run(transport).catch(() => undefined);
  const request = transport.requests[0];
  if (request === undefined) throw new Error("no command was issued");
  return request.commands[0];
}

/** Every tmux invocation a call made, as one argument list each. */
async function invocationsFor(
  run: (transport: Recorder) => Promise<unknown>,
): Promise<readonly (readonly string[])[]> {
  const transport = recorder(0);
  await run(transport).catch(() => undefined);
  return transport.requests.flatMap((request) => request.commands);
}

describe("lifecycle command arguments", () => {
  test("creates a window at an exact session index", () => {
    for (const index of [0, 3, 2_147_483_647]) {
      expect(planNewWindow("$4", { index }).argv).toContain(`$4:${String(index)}`);
    }
    expect(planNewWindow(null, { index: 3 }).argv).toContain(":3");
    expect(planNewWindow("$4").argv).toContain("$4");
  });

  test("refuses invalid or ambiguous window indexes before transport", () => {
    const transport = recorder();
    const runtime = runtimeFor(transport);
    for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => newWindow({} as never, runtime, "$4", { index })).toThrow(/index/u);
    }
    expect(() =>
      newWindow({} as never, runtime, "$4", { direction: WindowDirection.After, index: 3 }),
    ).toThrow(/direction/u);
    expect(transport.requests).toHaveLength(0);
  });

  test("guards a pane kill against a shared window", () => {
    expect(planKillPaneIfUnshared("%4").argv).toEqual([
      "if-shell",
      "-F",
      "-t",
      "%4",
      "#{==:#{window_linked},0}",
      "'kill-pane' '-t' '%4'",
      expect.stringMatching(/^'libtmux-shared-window-[0-9a-f]{32}'$/u),
    ]);
  });

  test("separates a window's shell command from tmux's own flags", async () => {
    const args = await argumentsFor((transport) =>
      newWindow({} as never, runtimeFor(transport), "$0", { shellCommand: "-n" }),
    );

    // Without the separator tmux reads `-n` as its window-name flag.
    expect(args.slice(-2)).toEqual(["--", "-n"]);
  });

  test("separates a pane's shell command from tmux's own flags", async () => {
    const args = await argumentsFor((transport) =>
      splitWindow({} as never, runtimeFor(transport), "%0", { shellCommand: "-c /tmp" }),
    );

    expect(args.slice(-2)).toEqual(["--", "-c /tmp"]);
  });

  test("separates a session's shell command from tmux's own flags", async () => {
    const args = await argumentsFor((transport) =>
      newSession({} as never, runtimeFor(transport), { name: "s", shellCommand: "-s other" }),
    );

    expect(args.slice(-2)).toEqual(["--", "-s other"]);
    // The name still arrives through its own flag rather than the command.
    expect(args).toContain("-s");
  });

  test("omits the separator when no command was asked for", async () => {
    const args = await argumentsFor((transport) =>
      newWindow({} as never, runtimeFor(transport), "$0", { name: "plain" }),
    );

    expect(args).not.toContain("--");
  });

  test("passes each environment pair as its own flag", async () => {
    for (const [label, run] of [
      [
        "new-session",
        (transport: Recorder) =>
          newSession({} as never, runtimeFor(transport), {
            environment: { EMPTY: "", PAIR: "a=b=c" },
          }),
      ],
      [
        "new-window",
        (transport: Recorder) =>
          newWindow({} as never, runtimeFor(transport), "$0", {
            environment: { EMPTY: "", PAIR: "a=b=c" },
          }),
      ],
      [
        "split-window",
        (transport: Recorder) =>
          splitWindow({} as never, runtimeFor(transport), "%0", {
            environment: { EMPTY: "", PAIR: "a=b=c" },
          }),
      ],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one command per creator.
      const args = await argumentsFor(run);
      // One flag per pair, so a value holding `=` is not split at the first one.
      expect(args).toEqual(expect.arrayContaining(["-e", "PAIR=a=b=c"]));
      expect(args).toEqual(expect.arrayContaining(["-e", "EMPTY="]));
      expect(args.filter((argument) => argument === "-e")).toHaveLength(2);
      expect(label).toBeDefined();
    }
  });

  test("sizes a split in cells or in a share of the pane", async () => {
    const cells = await argumentsFor((transport) =>
      splitWindow({} as never, runtimeFor(transport), "%0", { size: splitSize(20) }),
    );
    expect(cells.slice(cells.indexOf("-l"), cells.indexOf("-l") + 2)).toEqual(["-l", "20"]);

    const share = await argumentsFor((transport) =>
      splitWindow({} as never, runtimeFor(transport), "%0", { size: "30%" }),
    );
    expect(share.slice(share.indexOf("-l"), share.indexOf("-l") + 2)).toEqual(["-l", "30%"]);

    await Promise.all(
      (["0%", "100%"] as const).map(async (boundary) => {
        const sized = await argumentsFor((transport) =>
          splitWindow({} as never, runtimeFor(transport), "%0", { size: boundary }),
        );
        expect(sized.slice(sized.indexOf("-l"), sized.indexOf("-l") + 2)).toEqual(["-l", boundary]);
      }),
    );

    // Without it tmux halves the pane, and saying so is tmux's job not ours.
    const halved = await argumentsFor((transport) =>
      splitWindow({} as never, runtimeFor(transport), "%0", {}),
    );
    expect(halved).not.toContain("-l");
  });

  test("refuses split sizes tmux cannot interpret as an integer geometry", () => {
    for (const size of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => splitSize(size)).toThrow(/size/u);
      expect(() => planSplitWindow("%0", { size: size as never })).toThrow(/size/u);
    }
    for (const size of [
      "01%",
      "-0%",
      "-1%",
      "0x1%",
      "0o1%",
      "0b1%",
      "1.5%",
      "101%",
      "NaN%",
    ] as const) {
      expect(() => splitSize(size as never)).toThrow(/size/u);
      expect(() => planSplitWindow("%0", { size: size as never })).toThrow(/size/u);
    }
  });

  test("refuses names the supported tmux range does not carry identically", () => {
    // 3.2a through 3.6b rewrite a delimiter to `_`, 3.7 rejects the name, and
    // 3.7a onward stores it literally, so one call means three things.
    expect(() => planNewSession({ name: "a:b" })).toThrow("session name");
    expect(() => planNewSession({ name: "a.b" })).toThrow("session name");
    expect(() => planNewSession({ name: "" })).toThrow("session name");
    expect(() => planNewSession({ name: "a\u0007b" })).toThrow("session name");
    expect(() => planNewSession({ name: "a\u007fb" })).toThrow("session name");
    expect(() => planNewSession({ name: "a\ud800b" })).toThrow("unpaired surrogate");
    expect(() => planNewSession({ windowName: "a:b" })).toThrow("window name");
    expect(() => planNewWindow(null, { name: "a.b" })).toThrow("window name");
    expect(planNewSession({ name: "work" }).argv).toContain("work");
  });
});

describe("pane input command arguments", () => {
  test("sends the keys and Enter as two commands in one invocation", async () => {
    const transport = recorder(0);
    await sendKeys(runtimeFor(transport), "%0", "echo hello").catch(() => undefined);

    // Two invocations leave a gap in which another writer's Enter submits this
    // caller's half-typed line. One command leaves tmux resolving Enter
    // against the state the keys before it produced, which in copy mode is a
    // mode that is no longer there.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.commands).toEqual([
      ["send-keys", "-t", "%0", "echo hello"],
      ["send-keys", "-t", "%0", "Enter"],
    ]);
  });

  test("omits Enter when the caller does", async () => {
    const invocations = await invocationsFor((transport) =>
      sendKeys(runtimeFor(transport), "%0", "q", { enter: false }),
    );

    expect(invocations).toEqual([["send-keys", "-t", "%0", "q"]]);
  });

  test("keeps Enter a separate key when the text is literal", async () => {
    const invocations = await invocationsFor((transport) =>
      sendKeys(runtimeFor(transport), "%0", "Enter", { literal: true }),
    );

    // `-l` applies to every argument, so an Enter beside literal text would be
    // sent as the six characters rather than as the key.
    expect(invocations).toEqual([
      ["send-keys", "-t", "%0", "-l", "Enter"],
      ["send-keys", "-t", "%0", "Enter"],
    ]);
  });
});

describe("zoom command arguments", () => {
  test("selects the pane, then lets tmux decide the toggle", async () => {
    const invocations = await invocationsFor((transport) => zoomPane(runtimeFor(transport), "%0"));

    // `if-shell -t` sets where the condition expands, not where its branch
    // acts, so the branch carries its own target or it toggles whatever tmux
    // currently points at. The selection is what drops a sibling's zoom, since
    // `window_zoomed_flag` is true for every pane in a zoomed window.
    expect(invocations).toEqual([
      ["select-pane", "-t", "%0"],
      ["if-shell", "-F", "-t", "%0", "#{?window_zoomed_flag,0,1}", "'resize-pane' '-Z' '-t' '%0'"],
    ]);
  });

  test("sends both zoom commands as one invocation", async () => {
    const transport = recorder(0);
    await zoomPane(runtimeFor(transport), "%0").catch(() => undefined);

    // Two invocations would leave a pane selected but not zoomed for anyone
    // reading in between.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.commands).toHaveLength(2);
  });

  test("unzooms without selecting anything", async () => {
    const invocations = await invocationsFor((transport) =>
      unzoomTarget(runtimeFor(transport), "@3"),
    );

    expect(invocations).toEqual([
      ["if-shell", "-F", "-t", "@3", "#{window_zoomed_flag}", "'resize-pane' '-Z' '-t' '@3'"],
    ]);
  });
});
