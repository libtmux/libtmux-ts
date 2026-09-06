import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { TmuxTransportError, type Pane } from "libtmux";

import { isPaneInputConflict, reserveFramedCommand, runFramedCommand } from "../src/command.js";
import { frame, parseFramedOutput, randomId, withoutForeignFraming } from "../src/command_frame.js";
import type { InputAuthority, ToolContext } from "../src/context.js";
import { PaneTail } from "../src/pane_tail.js";
import { resolvePolicy } from "../src/policy.js";

describe("command framing", () => {
  const authority: InputAuthority = {
    endpointDevice: "2096",
    endpointInode: "9408963",
    pid: "42",
    routeSelector: "path:/tmp/libtmux-command-frame",
    socketPath: "/tmp/libtmux-command-frame",
    startTime: "700",
  };
  const shells = [
    ...new Set(
      ["sh", "bash", "dash", "zsh"].map((name) => Bun.which(name)).filter((path) => path !== null),
    ),
  ];

  function run(
    shell: string,
    source: string,
    input?: string,
  ): { readonly status: number | null; readonly stderr: string; readonly stdout: string } {
    const result = spawnSync(shell, ["-c", source], { encoding: "utf8", input });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  function quote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
  }

  function trapDirectory(source: string): string {
    const path = /'(\/tmp\/__ltx_[0-9a-f]+-traps)'/u.exec(source)?.[1];
    if (path === undefined) throw new Error("frame has no trap directory");
    return path;
  }

  function dispatchedFrame(args: readonly string[]): {
    readonly id: string;
    readonly source: string;
  } {
    const source = args.find((entry) => entry.includes("__ltx_"));
    if (source === undefined) throw new Error("tmux input has no frame");
    const octets = /command printf '%b' '((?:\\0[0-7]{3})+)'/u.exec(source)?.[1];
    if (octets === undefined) throw new Error("frame has no encoded id");
    const id = octets.replaceAll(/\\0([0-7]{3})/gu, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    return { id, source };
  }

  test("parses a complete framed result without pane state", () => {
    expect(
      parseFramedOutput(
        "prompt\r\nltxabc123def0_S\r\nresult\r\nltxabc123def0_E 7 ltxabc123def0_D\r\n",
        "ltxabc123def0",
      ),
    ).toEqual({
      exitStatus: 7,
      foreignOutputSuspected: false,
      output: "result",
      outputComplete: true,
    });
  });

  test("keeps a multiline command out of the shell history too", () => {
    // The leading space is the whole mechanism, and a shell records a
    // multiline buffer as one entry — so skipping it there put the shape most
    // likely to carry a secret, a pasted block, into the history file.
    expect(frame("echo one", "ltxabc123def0", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\necho two", "ltxabc123def0", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\recho two", "ltxabc123def0", true).startsWith(" ")).toBe(true);
  });

  test("leaves the space off when the caller did not ask for suppression", () => {
    expect(frame("echo one", "ltxabc123def0", false).startsWith(" ")).toBe(false);
    expect(frame("echo one\necho two", "ltxabc123def0", false).startsWith(" ")).toBe(false);
  });

  test("encodes multiline commands as one physical input line", () => {
    const command = "cat <<'LTX'\none\n\u2603\nLTX\nprintf 'done\\n'\n";
    for (const shell of shells) {
      const source = frame(command, "ltxabc123def0", false);
      expect(source, shell).not.toContain("\n");

      const result = run(shell, source);
      expect(result.status, shell).toBe(0);
      expect(result.stderr, shell).toBe("");
      expect(result.stdout, shell).toBe(
        "ltxabc123def0_S\none\n\u2603\ndone\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("leaves headroom below the interactive PTY line boundary", () => {
    expect(Buffer.byteLength(frame("true", "ltx0123456789", true))).toBeLessThan(3 * 1024);
  });

  test("closes the protocol after a command ending in a comment", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("printf 'before\\n' # trailing comment", "ltxabc123def0", false),
      );
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxabc123def0_S\nbefore\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("ignores unrelated input while waiting for the marker", () => {
    for (const shell of shells) {
      const result = run(shell, frame("printf 'own-output\\n'", "ltxabc123def0", false));
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxabc123def0_S\nown-output\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("normalizes carriage-return command text before the shell evaluates it", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("true\r\nprintf 'crlf-ok\\n'\rprintf 'cr-ok\\n'\r", "ltxabc123def0", false),
      );
      expect(result.status, shell).toBe(0);
      expect(result.stderr, shell).toBe("");
      expect(result.stdout, shell).toBe(
        "ltxabc123def0_S\ncrlf-ok\ncr-ok\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("reports a nonzero command under inherited errexit", () => {
    for (const shell of shells) {
      const source =
        `set -e\n${frame("printf 'before\\n'; false; printf 'SHOULD-NOT-RUN\\n'", "ltxabc123def0", false)}\n` +
        `case $- in *e*) printf 'errexit-on\\n';; esac`;
      const result = run(shell, source);
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxabc123def0_S\nbefore\nltxabc123def0_E 1 ltxabc123def0_D\nerrexit-on\n",
      );
    }
  });

  test("keeps framing private from inherited printf functions and aliases", () => {
    const id = "ltxabc123def0";
    for (const shell of shells) {
      const functionResult = run(
        shell,
        `printf() { command printf 'function:%s\\n' "$1"; }\n${frame(
          "printf 'command-call\\n'",
          id,
          false,
        )}`,
      );
      expect(functionResult.stdout, `${shell} function`).toContain("function:command-call\\n\n");
      expect(functionResult.stdout, `${shell} function`).toContain(`${id}_E 0 ${id}_D\n`);

      const framed = frame("printf command-alias", id, false);
      const aliasResult = run(
        shell,
        `shopt -s expand_aliases 2>/dev/null || :\n` +
          `alias printf='command printf "alias-call\\n"'\n` +
          `eval ${quote(framed)}`,
      );
      expect(aliasResult.stdout, `${shell} alias`).toContain("alias-call\n");
      expect(aliasResult.stdout, `${shell} alias`).toContain(`${id}_E 0 ${id}_D\n`);
    }
  });

  test("isolates command-defined shell state and a bare exit", () => {
    const id = "ltxabc123def0";
    for (const shell of shells) {
      const command =
        `inner_ltx() { :; }; trap 'command printf "inner-exit\\n"' 0; ` +
        `cd /; export LTX_FRAME_STATE=inner; exit 23`;
      const source =
        `LTX_FRAME_STATE=outer; before=$PWD; ` +
        `readonly ltx_marker=outer ltx_options=outer ltx_payload=outer ltx_traps=outer ltx_status=outer; ` +
        `trap 'command printf "outer-exit\\n"' 0\n` +
        `${frame(command, id, false)}\n` +
        `if [ "$PWD:$LTX_FRAME_STATE" = "$before:outer" ] && ` +
        `! command -v inner_ltx >/dev/null 2>&1; then command printf 'parent-stable\\n'; fi`;
      const result = run(shell, source);

      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toContain(`${id}_S\ninner-exit\n${id}_E 23 ${id}_D\n`);
      expect(result.stdout, shell).toEndWith("parent-stable\nouter-exit\n");
      expect(result.stdout.split("outer-exit\n"), shell).toHaveLength(2);
    }
  });

  test("closes the frame around invalid trailing syntax", () => {
    const id = "ltxabc123def0";
    for (const shell of shells) {
      const result = run(shell, frame("printf before; if", id, false));
      const parsed = parseFramedOutput(result.stdout, id);

      expect(result.status, shell).toBe(0);
      expect(parsed, shell).toBeDefined();
      expect(parsed?.exitStatus, shell).toBeGreaterThan(0);
    }
  });

  test("the command sees an inherited Bash ERR trap and the parent keeps it", () => {
    const bash = Bun.which("bash");
    expect(bash).not.toBeNull();
    const id = "ltxabc123def0";
    const result = run(
      bash ?? "bash",
      `trap 'command printf "outer-err:%s\\n" "$?"' ERR\n` +
        `${frame("false", id, false)}\n` +
        `false\n` +
        `command printf 'parent-after-err\\n'`,
    );

    const parsed = parseFramedOutput(result.stdout, id);
    expect(result.status).toBe(0);
    expect(parsed?.exitStatus).toBe(1);
    expect(parsed?.output).toContain("outer-err:1");
    expect(result.stdout).toEndWith("outer-err:1\nparent-after-err\n");
  });

  test("keeps the marker out of inherited Bash debug state", () => {
    const bash = Bun.which("bash");
    expect(bash).not.toBeNull();
    const command = `for value in "\${BASH_ARGV[@]}"; do printf '%s_E 0\\n' "$value"; done; exit 7`;
    const result = run(
      bash ?? "bash",
      `set -x\nshopt -s extdebug\n${frame(command, "ltxabc123def0", false)}\nprintf 'after-xtrace\\n' >/dev/null`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ltxabc123def0_S\nltxabc123def0_E 7 ltxabc123def0_D\n");
    expect(result.stderr).toContain("after-xtrace");
    expect(result.stderr).not.toContain("ltxabc123def0");
  });

  test("removes the marker before restoring an inherited Bash DEBUG trap", () => {
    const bash = Bun.which("bash");
    expect(bash).not.toBeNull();
    const trap =
      `trap 'for name in $(compgen -A variable __ltx_); do ` +
      `case "$name" in *_marker) captured="\${!name}";; esac; done' DEBUG`;
    const command = `printf '%s_E 0\n' "\${captured-}"; printf 'after-debug\n'; exit 7`;
    const result = run(
      bash ?? "bash",
      `set -T\n${trap}\n${frame(command, "ltxabc123def0", false)}`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "ltxabc123def0_S\n_E 0\nafter-debug\nltxabc123def0_E 7 ltxabc123def0_D\n",
    );
  });

  test.each([
    ["bash", "ERR"],
    ["zsh", "ZERR"],
  ] as const)("preserves inherited error and debug traps in %s commands", (name, errorSignal) => {
    const shell = Bun.which(name);
    if (shell === null) return;
    const id = "ltxabc123def0";
    const debug = `command printf 'debug:%s\\n' "$LTX_TRAP_SCOPE"`;
    const error = `command printf 'error:%s\\n' "$LTX_TRAP_SCOPE"`;
    const source =
      `LTX_TRAP_SCOPE=parent\n` +
      `trap ${quote(debug)} DEBUG\n` +
      `trap ${quote(error)} ${errorSignal}\n` +
      `${frame("LTX_TRAP_SCOPE=child; command printf 'body\\n'; false", id, false)}\n` +
      `false\n` +
      `command printf 'parent-finished\\n'`;
    const result = run(shell, source);
    const parsed = parseFramedOutput(result.stdout, id);

    expect(result.status, name).toBe(0);
    expect(parsed?.exitStatus, name).toBe(1);
    expect(parsed?.output, name).toContain("body");
    expect(parsed?.output, name).toContain("debug:child");
    expect(parsed?.output, name).toContain("error:child");
    expect(result.stdout.slice(result.stdout.indexOf(`${id}_D`) + id.length + 2), name).toContain(
      "error:parent",
    );
    expect(result.stdout, name).toEndWith("parent-finished\n");
    expect(existsSync(trapDirectory(source)), name).toBe(false);
  });

  test.each([
    ["bash", "ERR"],
    ["zsh", "ZERR"],
  ] as const)("refuses inherited %s trap declarations beyond 64 KiB", (name, errorSignal) => {
    const shell = Bun.which(name);
    if (shell === null) return;
    const id = "ltxabc123def0";
    const oversized = `__ltx_large=${"x".repeat(64 * 1024)}; true`;
    const framed = frame("command printf 'SHOULD-NOT-RUN\\n'", id, false);
    const result = run(shell, `trap ${quote(oversized)} ${errorSignal}\n${framed}`);
    const parsed = parseFramedOutput(result.stdout, id);

    expect(result.status, name).toBe(0);
    expect(parsed?.exitStatus, name).toBe(125);
    expect(parsed?.output, name).not.toContain("SHOULD-NOT-RUN");
    expect(existsSync(trapDirectory(framed)), name).toBe(false);
  });

  test("preserves inherited noglob in the command and parent shell", () => {
    const id = "ltxabc123def0";
    for (const shell of shells) {
      const source =
        `set -f\n` +
        `${frame(
          "case $- in *f*) command printf 'child-noglob\\n';; *) exit 95;; esac",
          id,
          false,
        )}\n` +
        `case $- in *f*) command printf 'parent-noglob\\n';; *) exit 96;; esac`;
      const result = run(shell, source);

      expect(result.status, shell).toBe(0);
      expect(parseFramedOutput(result.stdout, id)?.output, shell).toBe("child-noglob");
      expect(result.stdout, shell).toEndWith("parent-noglob\n");
    }
  });

  test("waits for the complete exit-status line", async () => {
    const tail = new PaneTail("%1");
    const pane = {
      format: { session_id: "$1" },
      id: "%1",
      cmd: async (_command: string, args: readonly string[]) => {
        const { id } = dispatchedFrame(args);
        setTimeout(() => tail.append(`${id}_S\nresult\n${id}_E 1`), 5);
        setTimeout(() => tail.append(`27 ${id}_D\n`), 20);
      },
    } as unknown as Pane;
    const context = {
      hub: { closed: false, tail: async () => tail },
      policy: resolvePolicy({}),
    } as unknown as ToolContext;

    const result = await runFramedCommand(context, pane, "exit 127", 500);

    expect(result.outcome).toBe("completed");
    expect(result.exitStatus).toBe(127);
  });

  test("falls back when a live tail wait fails after dispatch", async () => {
    const tail = new PaneTail("%1");
    let captureTimeoutMs: number | undefined;
    let id = "";
    let waitFailures = 0;
    tail.changed = async () => {
      waitFailures += 1;
      throw new Error("transient live-tail failure");
    };
    const pane = {
      capture: async (options: { readonly timeoutMs?: number }) => {
        captureTimeoutMs = options.timeoutMs;
        return id === "" ? [] : [`${id}_S`, "finished", `${id}_E 0 ${id}_D`];
      },
      format: { session_id: "$1" },
      height: 8,
      id: "%1",
      cmd: async (_command: string, args: readonly string[]) => {
        id = dispatchedFrame(args).id;
      },
      width: 80,
    } as unknown as Pane;
    const policy = resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "250" });
    const context = {
      hub: { closed: false, tail: async () => tail },
      policy,
    } as unknown as ToolContext;

    const result = await runFramedCommand(context, pane, "true", 500);

    expect(result.outcome).toBe("completed");
    expect(result.output).toBe("finished");
    expect(waitFailures).toBe(1);
    expect(captureTimeoutMs).toBeGreaterThan(0);
    expect(captureTimeoutMs).toBeLessThanOrEqual(500);
  });

  test("recognizes a right-padded, soft-wrapped fallback marker", async () => {
    let id = "";
    const pane = {
      capture: async (options: { readonly joinWrapped?: boolean }) => {
        if (id === "") return [];
        const end = `${id}_E 127 ${id}_D`;
        return options.joinWrapped === true
          ? [`${id}_S`, "result", `${end}   `]
          : [`${id}_S`, "result", end.slice(0, -2), `${end.slice(-2)}   `];
      },
      format: { session_id: "$1" },
      height: 8,
      id: "%1",
      cmd: async (_command: string, args: readonly string[]) => {
        id = dispatchedFrame(args).id;
      },
      width: 20,
    } as unknown as Pane;
    const context = {
      hub: { closed: false, tail: async () => undefined },
      policy: resolvePolicy({ LIBTMUX_MCP_LIVE: "0" }),
      snapshot: async () => ({ panes: { first: () => undefined } }),
    } as unknown as ToolContext;

    const result = await runFramedCommand(context, pane, "exit 127", 150);

    expect(result.outcome).toBe("completed");
    expect(result.exitStatus).toBe(127);
  });

  test("sends nothing for a command whose caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const sent: string[] = [];
    const pane = {
      capture: async () => [],
      cmd: async (_command: string, args: readonly string[]) => {
        sent.push(args.join(" "));
      },
      format: { session_id: "$1" },
      height: 8,
      id: "%1",
      width: 20,
    } as unknown as Pane;
    const context = {
      hub: { closed: false, tail: async () => undefined },
      policy: resolvePolicy({ LIBTMUX_MCP_LIVE: "0" }),
      snapshot: async () => ({ panes: { first: () => pane } }),
    } as unknown as ToolContext;

    const result = await runFramedCommand(
      context,
      pane,
      "touch SHOULD_NOT_RUN",
      1_000,
      controller.signal,
    );

    expect(result.outcome).toBe("cancelled");
    expect(result.commandStarted).toBe(false);
    expect(sent).toEqual([]);
  });

  test.each([
    ["caller cancellation", "cancelled", 1_000],
    ["deadline expiry", "timed_out", 5],
  ] as const)(
    "does not dispatch after %s during the final preflight",
    async (_, outcome, timeoutMs) => {
      const controller = new AbortController();
      const sent: string[] = [];
      const checked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pane = {
        cmd: async (_command: string, args: readonly string[]) => {
          sent.push(args.join(" "));
        },
        format: { session_id: "$1" },
        height: 8,
        id: "%1",
        width: 20,
      } as unknown as Pane;
      const context = {
        hub: { closed: false, tail: async () => undefined },
        policy: resolvePolicy({ LIBTMUX_MCP_LIVE: "0" }),
        snapshot: async () => ({ panes: { first: () => pane } }),
      } as unknown as ToolContext;

      const running = runFramedCommand(
        context,
        pane,
        "touch SHOULD_NOT_RUN",
        timeoutMs,
        controller.signal,
        true,
        async () => {
          checked.resolve();
          await release.promise;
          return pane;
        },
      );
      await checked.promise;
      if (outcome === "cancelled") controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, timeoutMs * 2));
      release.resolve();
      const result = await running;

      expect(result.outcome).toBe(outcome);
      expect(result.commandStarted).toBe(false);
      expect(sent).toEqual([]);
      expect(sent).not.toContain("C-c");
    },
  );

  test("keeps a cancelled command unsettled after its payload starts", async () => {
    const controller = new AbortController();
    const tail = new PaneTail("%1");
    let id = "";
    const pane = {
      format: { session_id: "$1" },
      id: "%1",
      cmd: async (_command: string, args: readonly string[]) => {
        id = dispatchedFrame(args).id;
        tail.append(`${id}_S\n`);
        controller.abort();
      },
    } as unknown as Pane;
    const context = {
      hub: { closed: false, tail: async () => tail },
      policy: resolvePolicy({}),
      snapshot: async () => ({ panes: { first: () => pane } }),
    } as unknown as ToolContext;

    const result = await runFramedCommand(context, pane, "touch STARTED", 1_000, controller.signal);
    let settled = false;
    void result.settled.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(result.outcome).toBe("cancelled");
    expect(result.commandStarted).toBe(true);
    expect(settled).toBe(false);

    tail.append(`${id}_E 0 ${id}_D\n`);
    await result.settled;
    expect(settled).toBe(true);
  });

  test("retries retained settlement after a live-tail failure", async () => {
    const controller = new AbortController();
    const tail = new PaneTail("%91");
    const observedSignals: (AbortSignal | undefined)[] = [];
    let captureTimeoutMs: number | undefined;
    let id = "";
    let tailFailed = false;
    tail.changed = async () => {
      tailFailed = true;
      throw new Error("transient live-tail failure");
    };
    const pane = {
      capture: async (options: { readonly timeoutMs?: number }) => {
        captureTimeoutMs = options.timeoutMs;
        return tailFailed ? [`${id}_S`, `${id}_E 0 ${id}_D`] : [];
      },
      format: { session_id: "$1" },
      height: 8,
      id: "%91",
      cmd: async (_command: string, args: readonly string[]) => {
        id = dispatchedFrame(args).id;
        tail.append(`${id}_S\n`);
        controller.abort();
      },
      width: 80,
    } as unknown as Pane;
    const policy = resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "250" });
    const context = {
      hub: { closed: false, tail: async () => tail },
      observeInput: async (signal?: AbortSignal) => {
        observedSignals.push(signal);
        return {
          authority,
          identity: {},
          snapshot: { panes: { first: () => pane } },
        };
      },
      policy,
    } as unknown as ToolContext;
    const reservation = reserveFramedCommand(authority, pane.id, "cancelled run");
    if (isPaneInputConflict(reservation)) throw new Error("reservation conflicted");

    try {
      const result = await runFramedCommand(
        context,
        pane,
        "true",
        1_000,
        controller.signal,
        true,
        undefined,
        authority,
      );
      reservation.settleWith(result.settled);

      expect(result.outcome).toBe("cancelled");
      await expect(result.settled).resolves.toBeUndefined();
      await Promise.resolve();

      const next = reserveFramedCommand(authority, pane.id, "next run");
      expect(isPaneInputConflict(next)).toBe(false);
      if (!isPaneInputConflict(next)) next.release();
      expect(observedSignals[0]).toBeDefined();
      expect(observedSignals[0]).not.toBe(controller.signal);
      expect(captureTimeoutMs).toBe(policy.commandTimeoutMs);
    } finally {
      reservation.release();
    }
  });

  test("reads a complete marker buffered before the live tail closes", async () => {
    const tail = new PaneTail("%1");
    const pane = {
      format: { session_id: "$1" },
      id: "%1",
      cmd: async (_command: string, args: readonly string[]) => {
        const { id } = dispatchedFrame(args);
        tail.append(`${id}_S\nfinished\n${id}_E 0 ${id}_D\n`);
        tail.close("hub_closed");
      },
    } as unknown as Pane;
    const context = {
      hub: { closed: true, tail: async () => tail },
      policy: resolvePolicy({}),
      snapshot: async () => ({ panes: { first: () => pane } }),
    } as unknown as ToolContext;

    const result = await runFramedCommand(context, pane, "true", 20);

    expect(result.outcome).toBe("completed");
    expect(result.output).toBe("finished");
  });

  test.each(["hub closure", "snapshot error"] as const)(
    "keeps a cancelled command reserved across ambiguous %s",
    async (ambiguity) => {
      const controller = new AbortController();
      const tail = new PaneTail("%1");
      const hub = { closed: false, tail: async () => tail };
      let id = "";
      const pane = {
        format: { session_id: "$1" },
        id: "%1",
        cmd: async (_command: string, args: readonly string[]) => {
          id = dispatchedFrame(args).id;
          tail.append(`${id}_S\n`);
          if (ambiguity === "hub closure") hub.closed = true;
          controller.abort();
        },
      } as unknown as Pane;
      const context = {
        hub,
        policy: resolvePolicy({}),
        snapshot: async () => {
          if (ambiguity === "snapshot error") throw new Error("snapshot unavailable");
          return { panes: { first: () => pane } };
        },
      } as unknown as ToolContext;

      const result = await runFramedCommand(
        context,
        pane,
        "touch STARTED",
        1_000,
        controller.signal,
      );
      let settled = false;
      void result.settled.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(result.commandStarted).toBe(true);
      expect(settled).toBe(false);

      tail.append(`${id}_E 0 ${id}_D\n`);
      await result.settled;
    },
  );

  test.each([
    ["not_started", false],
    ["written", true],
    ["replied", true],
    ["indeterminate", true],
  ] as const)("binds a %s dispatch error to its delivery state", async (delivery, started) => {
    const tail = new PaneTail("%1");
    let id = "";
    const pane = {
      capture: async () => [],
      cmd: async (_command: string, args: readonly string[]) => {
        id = dispatchedFrame(args).id;
        throw new TmuxTransportError("dispatch failed", { delivery, kind: "pipe" });
      },
      format: { session_id: "$1" },
      height: 8,
      id: "%1",
      width: 20,
    } as unknown as Pane;
    const context = {
      hub: { closed: false, tail: async () => tail },
      observeInput: async () => {
        throw new Error("ambiguous observation");
      },
      policy: resolvePolicy({}),
      snapshot: async () => ({ panes: { first: () => pane } }),
    } as unknown as ToolContext;
    const running = runFramedCommand(
      context,
      pane,
      "touch MAY_HAVE_RUN",
      5,
      undefined,
      true,
      undefined,
      authority,
    );

    if (!started) {
      await expect(running).rejects.toMatchObject({ delivery });
      return;
    }
    const result = await running;
    let settled = false;
    void result.settled.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(result.commandStarted).toBe(true);
    expect(result.outcome).toBe("timed_out");
    expect(settled).toBe(false);

    tail.append(`${id}_E 0 ${id}_D\n`);
    await result.settled;
  });

  test("does not release a timed-out command from an unauthenticated missing-pane snapshot", async () => {
    const tail = new PaneTail("%1");
    let id = "";
    const pane = {
      cmd: async (_command: string, args: readonly string[]) => {
        id = dispatchedFrame(args).id;
      },
      format: { session_id: "$1" },
      id: "%1",
    } as unknown as Pane;
    const context = {
      hub: { closed: false, tail: async () => tail },
      observeInput: async () => {
        throw new Error("authority unavailable");
      },
      policy: resolvePolicy({}),
      snapshot: async () => ({ panes: { first: () => undefined } }),
    } as unknown as ToolContext;

    const result = await runFramedCommand(
      context,
      pane,
      "touch MAY_STILL_RUN",
      5,
      undefined,
      true,
      undefined,
      authority,
    );
    let settled = false;
    void result.settled.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(result.outcome).toBe("timed_out");
    expect(settled).toBe(false);

    tail.append(`${id}_E 0 ${id}_D\n`);
    await result.settled;
  });

  test("settles only when the captured daemon generation disappears", async () => {
    const controller = new AbortController();
    const tail = new PaneTail("%1");
    const pane = {
      cmd: async (_command: string, args: readonly string[]) => {
        const { id } = dispatchedFrame(args);
        tail.append(`${id}_S\n`);
        controller.abort();
      },
      format: { session_id: "$1" },
      id: "%1",
    } as unknown as Pane;
    const replacement = { ...authority, startTime: "701" };
    const context = {
      hub: { closed: false, tail: async () => tail },
      observeInput: async () => ({
        authority: replacement,
        identity: {},
        snapshot: { panes: { first: () => pane } },
      }),
      policy: resolvePolicy({}),
      snapshot: async () => ({ panes: { first: () => pane } }),
    } as unknown as ToolContext;

    const result = await runFramedCommand(
      context,
      pane,
      "touch OLD_DAEMON",
      1_000,
      controller.signal,
      true,
      undefined,
      authority,
    );

    expect(result.commandStarted).toBe(true);
    await expect(result.settled).resolves.toBeUndefined();
  });
});

describe("concurrent framing", () => {
  // The stream one caller sees when a second caller types into the same pane
  // partway through: the second command's echo, its markers, and its output.
  const contaminated = [
    "AAA-start",
    ` __ltx_abc123() { printf '%s\\n' "\${1}_S"; ( set --; echo BBB-secret )`,
    "ltxbbb222_S",
    "BBB-secret",
    "ltxbbb222_E 0",
    "AAA-end",
  ].join("\n");

  test("keeps another caller's command and output out of this one's", () => {
    const cleaned = withoutForeignFraming(contaminated, "ltxaaa111");
    expect(cleaned.text).toBe("AAA-start\nAAA-end");
    expect(cleaned.text).not.toContain("BBB-secret");
    expect(cleaned.text).not.toContain("ltxbbb222");
    // Removed, and said so: what was cleaned is still evidence that the pane
    // had another writer, so output with no marker may be theirs too.
    expect(cleaned.foreignOutputSuspected).toBe(true);
  });

  test("leaves this caller's own output alone and claims nothing", () => {
    const cleaned = withoutForeignFraming("one\ntwo\nthree", "ltxaaa111");
    expect(cleaned.text).toBe("one\ntwo\nthree");
    expect(cleaned.foreignOutputSuspected).toBe(false);
  });

  test("reports what it cannot bracket rather than guessing", () => {
    // A background job is a genuinely concurrent writer: its start marker
    // lands inside this body with no end marker to bracket it. Dropping to
    // the end would take OURS-end, which is real output, so the orphaned line
    // stays and the result says another writer was here.
    const unterminated = ["OURS-start", "ltxdeadbeef01_S", "FOREIGN-SECRET-42", "OURS-end"].join(
      "\n",
    );
    const cleaned = withoutForeignFraming(unterminated, "ltxaaa111");
    expect(cleaned.text).toContain("OURS-start");
    expect(cleaned.text).toContain("OURS-end");
    expect(cleaned.text).not.toContain("ltxdeadbeef01");
    // The honest part: the secret is still there, and the caller is told so
    // rather than handed it silently or handed a hole silently.
    expect(cleaned.foreignOutputSuspected).toBe(true);
  });
});

describe("framing ids", () => {
  test("the scrubber recognises the ids this server actually mints", () => {
    // MARKER matches lowercase hex, which is what randomId emits today, and
    // nothing else says the two are coupled. Widen the alphabet and the
    // scrubber stops recognising foreign framing — it would report clean
    // output and keep the other caller's, a disclosure failure with no
    // symptom. This is the only thing that would go red.
    for (let index = 0; index < 200; index += 1) {
      const minted = `ltx${randomId()}`;
      const seen = withoutForeignFraming(`ours\n${minted}_S\ntheirs`, "ltxnottheone");
      expect(seen.foreignOutputSuspected, `${minted} was not recognised as framing`).toBe(true);
    }
  });
});
