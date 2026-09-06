import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { Pane } from "libtmux";

import { runFramedCommand } from "../src/command.js";
import { frame, parseFramedOutput, randomId, withoutForeignFraming } from "../src/command_frame.js";
import type { ToolContext } from "../src/context.js";
import { PaneTail } from "../src/pane_tail.js";
import { resolvePolicy } from "../src/policy.js";

describe("command framing", () => {
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
    expect(frame("echo one", "ltxready", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\necho two", "ltxready", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\recho two", "ltxready", true).startsWith(" ")).toBe(true);
  });

  test("leaves the space off when the caller did not ask for suppression", () => {
    expect(frame("echo one", "ltxready", false).startsWith(" ")).toBe(false);
    expect(frame("echo one\necho two", "ltxready", false).startsWith(" ")).toBe(false);
  });

  test("encodes multiline commands as one physical input line", () => {
    const command = "cat <<'LTX'\none\n\u2603\nLTX\nprintf 'done\\n'\n";
    for (const shell of shells) {
      const source = frame(command, "ltxready", false);
      expect(source, shell).not.toContain("\n");

      const result = run(shell, source, "ltxabc123def0\n");
      expect(result.status, shell).toBe(0);
      expect(result.stderr, shell).toBe("");
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\none\n\u2603\ndone\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("leaves headroom below the interactive PTY line boundary", () => {
    expect(Buffer.byteLength(frame("true", "ltxr0123456789", true))).toBeLessThan(3 * 1024);
  });

  test("closes the protocol after a command ending in a comment", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("printf 'before\\n' # trailing comment", "ltxready", false),
        "ltxabc123def0\n",
      );
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\nbefore\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("ignores unrelated input while waiting for the marker", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("printf 'own-output\\n'", "ltxready", false),
        "other\nltxabc123def0\n",
      );
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\nown-output\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("normalizes carriage-return command text before the shell evaluates it", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("true\r\nprintf 'crlf-ok\\n'\rprintf 'cr-ok\\n'\r", "ltxready", false),
        "ltxabc123def0\n",
      );
      expect(result.status, shell).toBe(0);
      expect(result.stderr, shell).toBe("");
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\ncrlf-ok\ncr-ok\nltxabc123def0_E 0 ltxabc123def0_D\n",
      );
    }
  });

  test("reports a nonzero command under inherited errexit", () => {
    for (const shell of shells) {
      const source =
        `set -e\n${frame("printf 'before\\n'; false; printf 'SHOULD-NOT-RUN\\n'", "ltxready", false)}\n` +
        `case $- in *e*) printf 'errexit-on\\n';; esac`;
      const result = run(shell, source, "ltxabc123def0\n");
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\nbefore\nltxabc123def0_E 1 ltxabc123def0_D\nerrexit-on\n",
      );
    }
  });

  test("keeps framing private from inherited printf functions and aliases", () => {
    const id = "ltxabc123def0";
    for (const shell of shells) {
      const ready = "ltxready";
      const functionResult = run(
        shell,
        `printf() { command printf 'function:%s\\n' "$1"; }\n${frame(
          "printf 'command-call\\n'",
          ready,
          false,
        )}`,
        `${id}\n`,
      );
      expect(functionResult.stdout, `${shell} function`).toContain(`${ready}_R\n`);
      expect(functionResult.stdout, `${shell} function`).toContain("function:command-call\\n\n");
      expect(functionResult.stdout, `${shell} function`).toContain(`${id}_E 0 ${id}_D\n`);

      const framed = frame("printf command-alias", ready, false);
      const aliasResult = run(
        shell,
        `shopt -s expand_aliases 2>/dev/null || :\n` +
          `alias printf='command printf "alias-call\\n"'\n` +
          `eval ${quote(framed)}`,
        `${id}\n`,
      );
      expect(aliasResult.stdout, `${shell} alias`).toContain(`${ready}_R\n`);
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
        `${frame(command, "ltxready", false)}\n` +
        `if [ "$PWD:$LTX_FRAME_STATE" = "$before:outer" ] && ` +
        `! command -v inner_ltx >/dev/null 2>&1; then command printf 'parent-stable\\n'; fi`;
      const result = run(shell, source, `${id}\n`);

      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toContain(`${id}_S\ninner-exit\n${id}_E 23 ${id}_D\n`);
      expect(result.stdout, shell).toEndWith("parent-stable\nouter-exit\n");
      expect(result.stdout.split("outer-exit\n"), shell).toHaveLength(2);
    }
  });

  test("closes the frame around invalid trailing syntax", () => {
    const id = "ltxabc123def0";
    for (const shell of shells) {
      const result = run(shell, frame("printf before; if", "ltxready", false), `${id}\n`);
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
        `${frame("false", "ltxready", false)}\n` +
        `false\n` +
        `command printf 'parent-after-err\\n'`,
      `${id}\n`,
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
      `set -x\nshopt -s extdebug\n${frame(command, "ltxready", false)}\nprintf 'after-xtrace\\n' >/dev/null`,
      "ltxabc123def0\n",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ltxready_R\nltxabc123def0_S\nltxabc123def0_E 7 ltxabc123def0_D\n");
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
      `set -T\n${trap}\n${frame(command, "ltxready", false)}`,
      "ltxabc123def0\n",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "ltxready_R\nltxabc123def0_S\n_E 0\nafter-debug\nltxabc123def0_E 7 ltxabc123def0_D\n",
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
      `${frame("LTX_TRAP_SCOPE=child; command printf 'body\\n'; false", "ltxready", false)}\n` +
      `false\n` +
      `command printf 'parent-finished\\n'`;
    const result = run(shell, source, `${id}\n`);
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
    const framed = frame("command printf 'SHOULD-NOT-RUN\\n'", "ltxready", false);
    const result = run(shell, `trap ${quote(oversized)} ${errorSignal}\n${framed}`, `${id}\n`);
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
          "ltxready",
          false,
        )}\n` +
        `case $- in *f*) command printf 'parent-noglob\\n';; *) exit 96;; esac`;
      const result = run(shell, source, `${id}\n`);

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
      sendKeys: async (line: string) => {
        const ready = /'(ltxr[0-9a-f]{10})' '_R'/u.exec(line)?.[1];
        if (ready !== undefined) {
          tail.append(`${ready}_R\n`);
          return;
        }
        setTimeout(() => tail.append(`${line}_S\nresult\n${line}_E 1`), 5);
        setTimeout(() => tail.append(`27 ${line}_D\n`), 20);
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

  test("recognizes a right-padded, soft-wrapped fallback marker", async () => {
    let id = "";
    let ready = "";
    const pane = {
      capture: async (options: { readonly joinWrapped?: boolean }) => {
        if (id === "") return [`${ready}_R   `];
        const end = `${id}_E 127 ${id}_D`;
        return options.joinWrapped === true
          ? [`${ready}_R   `, `${id}_S`, "result", `${end}   `]
          : [`${ready}_R   `, `${id}_S`, "result", end.slice(0, -2), `${end.slice(-2)}   `];
      },
      format: { session_id: "$1" },
      height: 8,
      id: "%1",
      sendKeys: async (line: string) => {
        ready = /'(ltxr[0-9a-f]{10})' '_R'/u.exec(line)?.[1] ?? ready;
        if (/^ltx[0-9a-f]{10}$/u.test(line)) id = line;
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
      format: { session_id: "$1" },
      height: 8,
      id: "%1",
      sendKeys: async (line: string) => {
        sent.push(line);
      },
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
    "does not start after %s during a fallback capture",
    async (_, outcome, timeoutMs) => {
      const controller = new AbortController();
      const sent: string[] = [];
      let ready = "";
      let captureCount = 0;
      let captureOptions: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {};
      const firstCapture = Promise.withResolvers<string[]>();
      const capturing = Promise.withResolvers<void>();
      const pane = {
        capture: async (options: {
          readonly signal?: AbortSignal;
          readonly timeoutMs?: number;
        }) => {
          captureCount += 1;
          if (captureCount === 1) {
            captureOptions = options;
            capturing.resolve();
            return firstCapture.promise;
          }
          return [`${ready}_R`];
        },
        format: { session_id: "$1" },
        height: 8,
        id: "%1",
        sendKeys: async (line: string) => {
          sent.push(line);
          ready = /'(ltxr[0-9a-f]{10})' '_R'/u.exec(line)?.[1] ?? ready;
        },
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
      );
      await capturing.promise;
      if (outcome === "cancelled") controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, timeoutMs * 2));
      firstCapture.resolve([`${ready}_R`]);
      const result = await running;

      expect(result.outcome).toBe(outcome);
      expect(result.commandStarted).toBe(false);
      expect(captureOptions.signal).toBe(controller.signal);
      expect(captureOptions.timeoutMs).toBeGreaterThan(0);
      expect(captureOptions.timeoutMs).toBeLessThanOrEqual(timeoutMs);
      expect(sent.some((line) => /^ltx[0-9a-f]{10}$/u.test(line))).toBe(false);
      expect(sent.at(-1)).toBe("C-c");
    },
  );

  test("keeps a cancelled command unsettled after its payload starts", async () => {
    const controller = new AbortController();
    const tail = new PaneTail("%1");
    let id = "";
    const pane = {
      format: { session_id: "$1" },
      id: "%1",
      sendKeys: async (line: string) => {
        const ready = /'(ltxr[0-9a-f]{10})' '_R'/u.exec(line)?.[1];
        if (ready !== undefined) tail.append(`${ready}_R\n`);
        else {
          id = line;
          tail.append(`${id}_S\n`);
          controller.abort();
        }
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
