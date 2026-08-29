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
import { planKillPaneIfUnshared, planSplitWindow } from "../../src/_internal/operations/plans.js";
import { splitSize } from "../../src/types.js";

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

function recorder(): Recorder {
  const requests: CommandRequest[] = [];
  return {
    requests,
    // Resolving the created object needs a snapshot this fixture does not
    // build, so the call fails after the arguments have been recorded.
    execute(request: CommandRequest): Promise<RawCommandResult> {
      requests.push(request);
      return Promise.resolve({
        cmd: request.args,
        returncode: 1,
        signal: null,
        // The transport boundary is bytes; decoding happens above it.
        stderr: new TextEncoder().encode("stopped\n"),
        stdout: new Uint8Array(),
      });
    },
    // One command at a time: this fixture records arguments and never
    // resolves what a group would return.
    executeGroup(): Promise<readonly RawCommandResult[]> {
      return Promise.reject(new Error("this fixture runs one command at a time"));
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
  return request.args;
}

describe("lifecycle command arguments", () => {
  test("guards a pane kill against a shared window", () => {
    expect(planKillPaneIfUnshared("%4").argv).toEqual([
      "if-shell",
      "-F",
      "-t",
      "%4",
      "#{==:#{window_linked},0}",
      "'kill-pane' '-t' '%4'",
      "'list-windows' '-t' 'libtmux-shared-window'",
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
});
