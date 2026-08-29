// The library's real-tmux fixture harness reaches into its internals, so it is
// unpublished and an in-repo consumer reaches across packages for it by path.
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { LiveHub } from "../src/live.js";
import { createTmuxMcpServer } from "../src/server.js";
import { paneContentUri } from "../src/uris.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/run_root.js";
import { TestServer } from "../../libtmux/src/_internal/test/test_server.js";
import { Server } from "libtmux/server";

import {
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../libtmux/src/_internal/test/temp_root.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-mcp-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "mcp" });
        assertOwnedSocketPath(fixture.socketPath);
        await runWithCleanup(
          () => body(fixture),
          () => fixture.dispose(),
        );
      },
      async () => {
        if (published === undefined) await reapOwnedRunRoot(runRoot);
        done = true;
      },
    );
  } finally {
    if (done) await rm(parent, { force: true, recursive: true });
  }
}

/** Text content from a tool result. */
function toolText(result: unknown): string {
  const { content } = result as { content: readonly { text?: string }[] };
  return content.map((entry) => entry.text ?? "").join("\n");
}

/** The typed half of a tool result, which is what a program reads. */
function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

/**
 * Talk to the server the way a client does: as a subprocess, over stdio.
 *
 * In-process construction proves the tools were registered; it does not prove
 * an argument survives JSON, that a result is shaped the way the protocol wants,
 * or that the process can be pointed at a socket by environment alone — which is
 * the only configuration an MCP client gives it.
 */
async function withClient(
  fixture: TestServer,
  body: (client: Client) => Promise<void>,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const client = new Client({ name: "libtmux-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    args: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    command: process.execPath,
    env: {
      ...(process.env as Record<string, string>),
      ...fixture.controllerEnvironment,
      LIBTMUX_SOCKET_PATH: fixture.socketPath,
      LIBTMUX_TMUX_BIN: fixture.tmuxExecutable,
      // Most integration cases exercise mutations. Production has a narrower
      // default; this harness opts in explicitly.
      LIBTMUX_SAFETY: "mutating",
      // A probe must not reach the terminal the suite is being run from.
      TMUX: "",
      TMUX_PANE: "",
      ...extraEnvironment,
    },
  });
  await runWithCleanup(
    async () => {
      await client.connect(transport);
      await body(client);
    },
    () => client.close(),
  );
}

async function firstPaneId(client: Client): Promise<string> {
  const listed = await client.callTool({ arguments: {}, name: "list_panes" });
  const { panes } = structured<{ panes: { id: string }[] }>(listed);
  return panes[0]?.id ?? "";
}

/**
 * A pane sitting at a shell prompt.
 *
 * The fixture's own pane runs `exec cat` so it stays quiet and deterministic,
 * which is the opposite of what these tests need: a shell that echoes, runs
 * what it is sent, and has an exit status. `sh` rather than the ambient login
 * shell, so the suite does not depend on whoever is running it.
 */
let shellSessions = 0;
async function shellPaneId(client: Client): Promise<string> {
  shellSessions += 1;
  const built = structured<{ panes: { id: string }[] }>(
    await client.callTool({
      arguments: {
        session: `shell-${String(shellSessions)}`,
        windows: [{ name: "shell", shellCommand: "sh" }],
      },
      name: "build_workspace",
    }),
  );
  return built.panes[0]?.id ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Attach a terminal client, which tmux distinguishes from control clients. */
async function withAttendedPane(
  fixture: TestServer,
  body: (paneId: string) => Promise<void>,
): Promise<void> {
  const command = [
    fixture.tmuxExecutable,
    "-S",
    fixture.socketPath,
    "attach-session",
    "-t",
    fixture.sessionId,
  ]
    .map(shellQuote)
    .join(" ");
  const terminal = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
    env: { ...fixture.controllerEnvironment, TERM: "xterm-256color" },
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  let attached: { name: string; paneId: string } | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (attached === undefined && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- each read observes a later attach state.
      const client = (await serverFor(fixture).snapshot()).clients
        .toArray()
        .find((candidate) => candidate.controlMode === false && candidate.paneId !== null);
      if (client?.paneId !== null && client?.paneId !== undefined) {
        attached = { name: client.name ?? "", paneId: client.paneId };
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- bounded polling must wait before the next read.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (attached === undefined) throw new Error("terminal client did not attach");
    await body(attached.paneId);
  } finally {
    if (attached?.name !== undefined && attached.name !== "") {
      await fixture.executeText(["detach-client", "-t", attached.name]).catch(() => undefined);
    }
    if (terminal.exitCode === null) terminal.kill();
    await Promise.race([
      terminal.exitCode === null ? once(terminal, "close") : Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

describe("handshake", () => {
  test("tells a client how to use it before it calls anything", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const instructions = client.getInstructions() ?? "";
        // The three things a wrong first choice costs a turn on.
        expect(instructions).toContain("WAIT, DON'T POLL");
        expect(instructions).toContain("ANTI-TRIGGERS");
        expect(instructions).toContain("METADATA vs CONTENT");
      });
    });
  }, 60_000);

  test("annotates every tool so a host can decide what to auto-approve", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(30);
        for (const tool of tools) {
          expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
          expect(tool.outputSchema, `${tool.name} has no output schema`).toBeDefined();
          expect(tool.description ?? "", `${tool.name} has no description`).not.toBe("");
        }
        const readers = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
        expect(readers.map((tool) => tool.name)).toContain("list_panes");
        // send_keys runs whatever the shell does, which is outside tmux.
        expect(tools.find((tool) => tool.name === "send_keys")?.annotations?.openWorldHint).toBe(
          true,
        );
      });
    });
  }, 60_000);
});

describe("running commands", () => {
  test("reports what a command printed, not the pane's echo of it", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // The trap: the text waited for is also in the command being sent.
        const answer = await client.callTool({
          arguments: { command: "echo hello", paneId },
          name: "run_command",
        });
        const result = structured<{ exitStatus: number; outcome: string; output: string }>(answer);
        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(0);
        expect(result.output).toBe("hello");
      });
    });
  }, 60_000);

  test("reports a failing command's status rather than guessing from text", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const answer = await client.callTool({
          arguments: { command: "exit 7", paneId },
          name: "run_command",
        });
        expect(structured<{ exitStatus: number }>(answer).exitStatus).toBe(7);
      });
    });
  }, 60_000);

  test("does not expose its completion marker to the command", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const answer = await client.callTool({
          arguments: {
            command: `printf '%s\n' "\${m}_E 0" "\${1}_E 0"; printf 'after-forge\n'; exit 7`,
            paneId,
          },
          name: "run_command",
        });
        const result = structured<{ exitStatus: number; outcome: string; output: string }>(answer);

        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(7);
        expect(result.output).toContain("after-forge");
      });
    });
  }, 60_000);

  test("does not overwrite shell variables outside the command", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { keys: "m=kept-marker; s=kept-status", paneId },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: { command: `printf '%s|%s\n' "$m" "$s"`, paneId },
          name: "run_command",
        });

        expect(structured<{ output: string }>(answer).output).toBe("kept-marker|kept-status");
      });
    });
  }, 60_000);

  test("frames commands when common shell variables are readonly", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { keys: "readonly m=kept-marker s=kept-status", paneId },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: { command: "printf 'readonly-ok\\n'", paneId, timeoutMs: 2_000 },
          name: "run_command",
        });
        const result = structured<{ outcome: string; output: string }>(answer);

        expect(result.outcome).toBe("completed");
        expect(result.output).toBe("readonly-ok");
      });
    });
  }, 60_000);

  test("says a command is still running instead of calling it failed", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const answer = await client.callTool({
          arguments: { command: "sleep 30", paneId, timeoutMs: 1_500 },
          name: "run_command",
        });
        const result = structured<{ outcome: string; stillRunning: boolean }>(answer);
        expect(result.outcome).toBe("timed_out");
        expect(result.stillRunning).toBe(true);
      });
    });
  }, 60_000);

  test("refuses a shell whose syntax the framing is not written in", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const built = structured<{ panes: { id: string }[] }>(
          await client.callTool({
            arguments: { session: "fishy", windows: [{ name: "f", shellCommand: "fish" }] },
            name: "build_workspace",
          }),
        );
        const paneId = built.panes[0]?.id ?? "";
        const refused = await client.callTool({
          arguments: { command: "echo hi", paneId },
          name: "run_command",
        });
        // fish does not share the wrapper's POSIX subshell grammar, so framing
        // a command for it produces a syntax error and a wait against one.
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("fish");
        expect(toolText(refused)).toContain("send_keys");
      });
    });
  }, 60_000);

  test("refuses a pane that is not at a shell, and says which command holds it", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { command: "sleep 30", paneId, timeoutMs: 1_000 },
          name: "run_command",
        });
        const refused = await client.callTool({
          arguments: { command: "echo late", paneId },
          name: "run_command",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("sleep");
        expect(toolText(refused)).toContain("force");
      });
    });
  }, 60_000);
});

describe("waiting", () => {
  test("keeps what arrived during a wait that did not match", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Start the stream, so what follows is inside the wait's own window.
        await client.callTool({ arguments: { paneId }, name: "observe" });
        await client.callTool({
          arguments: { keys: "(sleep 1; printf 'something-else\\n') &", paneId },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["never-printed-by-this"], timeoutMs: 4_000 },
          name: "wait_for_text",
        });
        const result = structured<{ cursor: number; outcome: string; output: string }>(answer);
        // The whole point: a timeout is evidence, not an empty hand.
        expect(result.outcome).toBe("timed_out");
        expect(result.output).toContain("something-else");
        expect(result.cursor).toBeGreaterThan(0);
        expect((answer as { isError?: boolean }).isError ?? false).toBe(false);
      });
    });
  }, 60_000);

  test("shows the pane's screen when it printed before the wait began", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { command: "echo printed-earlier", paneId },
          name: "run_command",
        });
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["never-printed-by-this"], timeoutMs: 1_500 },
          name: "wait_for_text",
        });
        const result = structured<{ outcome: string; screen: string }>(answer);
        // A control client is told nothing from before it attached, so the
        // stream cannot hold this. Without the screen the agent is blind.
        expect(result.outcome).toBe("timed_out");
        expect(result.screen).toContain("printed-earlier");
      });
    });
  }, 60_000);

  test("says the pattern is already on the pane rather than only timing out", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Printed through tmux directly, so nothing here has ever streamed this
        // pane and the line cannot be in the stream — the shape an agent meets
        // when it is handed a task about a process somebody else started. The
        // wait still must not match it: stale text satisfying a wait is the bug
        // this avoids. But "it printed before you asked" and "it never printed"
        // are different answers, and a real agent had to work that out itself.
        await fixture.executeText(["send-keys", "-t", paneId, "echo migration-complete", "Enter"]);
        await new Promise((resolve) => setTimeout(resolve, 750));
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["migration-complete"], timeoutMs: 1_500 },
          name: "wait_for_text",
        });
        const result = structured<{
          alreadyOnScreen: boolean;
          matched: string | null;
          outcome: string;
        }>(answer);
        expect({
          alreadyOnScreen: result.alreadyOnScreen,
          matched: result.matched,
          outcome: result.outcome,
        }).toEqual({ alreadyOnScreen: true, matched: null, outcome: "timed_out" });
        expect(toolText(answer)).toContain("printed before this wait began");
        expect(toolText(answer)).toContain("capture_pane");
      });
    });
  }, 90_000);

  test("does not claim a pattern is on the pane when it is not", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["never-printed-anywhere"], timeoutMs: 1_500 },
          name: "wait_for_text",
        });
        expect(structured<{ alreadyOnScreen: boolean }>(answer).alreadyOnScreen).toBe(false);
      });
    });
  }, 90_000);

  test("reports a pane that died mid-wait rather than waiting out the deadline", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // A second window keeps the session alive when the first pane's shell
        // exits, so what the wait meets is a dead pane rather than a stream
        // whose whole session went away — two different answers.
        const built = structured<{ panes: { id: string }[] }>(
          await client.callTool({
            arguments: {
              session: "dying-pane",
              windows: [
                { name: "shell", shellCommand: "sh" },
                { name: "keep", shellCommand: "sleep 600" },
              ],
            },
            name: "build_workspace",
          }),
        );
        const paneId = built.panes[0]?.id ?? "";
        await client.callTool({ arguments: { keys: "sleep 1; exit", paneId }, name: "send_keys" });

        const started = Date.now();
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["never-printed-anywhere"], timeoutMs: 30_000 },
          name: "wait_for_text",
        });
        const elapsed = Date.now() - started;

        expect(structured<{ outcome: string }>(answer).outcome).toBe("pane_died");
        // The point is when, not what. A pane's death is not output, so nothing
        // wakes the wait to announce it; asked only at the deadline, this same
        // answer arrived thirty seconds late.
        expect(elapsed).toBeLessThan(15_000);
      });
    });
  }, 90_000);

  test("clamps an over-large timeout and reports the one it used", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await firstPaneId(client);
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["nope"], timeoutMs: 999_999_999 },
          name: "wait_for_text",
        });
        expect(structured<{ effectiveTimeoutMs: number }>(answer).effectiveTimeoutMs).toBe(30_000);
      });
    });
  }, 90_000);

  test("matches output another process wrote", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { keys: "(sleep 1; printf 'from-elsewhere\\n') &", paneId },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["from-elsewhere"], timeoutMs: 20_000 },
          name: "wait_for_text",
        });
        const result = structured<{ matched: string; outcome: string }>(answer);
        expect(result.outcome).toBe("matched");
        expect(result.matched).toBe("from-elsewhere");
      });
    });
  }, 60_000);

  test("serves the task form to a client that does not speak tasks", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { keys: "(sleep 1; printf 'task-marker\\n') &", paneId },
          name: "send_keys",
        });
        // taskSupport is optional, so the SDK polls on this client's behalf and
        // it sees exactly the blocking tool. That is what makes shipping tasks
        // safe rather than a compatibility break.
        const answer = await client.callTool({
          arguments: { paneId, patterns: ["task-marker"], timeoutMs: 20_000 },
          name: "wait_for_text_task",
        });
        expect(structured<{ outcome: string }>(answer).outcome).toBe("matched");
      });
    });
  }, 60_000);
});

test("leaves a pane usable straight after a caller cancels a wait on it", async () => {
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const paneId = await shellPaneId(client);
      const controller = new AbortController();

      const pending = client.callTool(
        {
          arguments: { paneId, patterns: ["never-arrives"], timeoutMs: 30_000 },
          name: "wait_for_text",
        },
        undefined,
        { signal: controller.signal },
      );
      setTimeout(() => {
        controller.abort();
      }, 500);

      // The rejection says nothing about the server, which is why what is
      // asserted is that the pane is immediately usable afterwards rather
      // than how quickly the caller was let go.
      await pending.catch(() => undefined);

      const after = await client.callTool({
        arguments: { command: "echo still-usable", paneId },
        name: "run_command",
      });
      expect(structured<{ output: string }>(after).output).toBe("still-usable");
    });
  });
}, 60_000);

describe("observing", () => {
  test("charges for the screen once, then only for what is new", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);

        const first = structured<{ cursor: number; seeded: boolean; streaming: boolean }>(
          await client.callTool({ arguments: { paneId }, name: "observe" }),
        );
        expect(first.seeded).toBe(true);
        expect(first.streaming).toBe(true);

        await client.callTool({
          arguments: { keys: "printf 'delta-one\\n'", paneId },
          name: "send_keys",
        });
        const second = structured<{ cursor: number; seeded: boolean; text: string }>(
          await client.callTool({
            arguments: { cursor: first.cursor, paneId, waitMs: 10_000 },
            name: "observe",
          }),
        );
        expect(second.seeded).toBe(false);
        expect(second.cursor).toBeGreaterThan(first.cursor);

        // Nothing happened since, so the delta is empty rather than the screen.
        // This used to pass a cursor a million bytes past the end, which is the
        // same empty answer for the wrong reason — the pane could have been
        // printing throughout and this would still have read "".
        const third = structured<{ text: string }>(
          await client.callTool({
            arguments: { cursor: second.cursor, paneId, waitMs: 200 },
            name: "observe",
          }),
        );
        expect(third.text).toBe("");
      });
    });
  }, 60_000);

  test("finds which pane is showing something", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { command: "echo needle-in-pane", paneId },
          name: "run_command",
        });
        const found = structured<{ matches: { paneId: string; text: string }[] }>(
          await client.callTool({ arguments: { pattern: "needle-in-pane" }, name: "search_panes" }),
        );
        expect(found.matches.map((match) => match.paneId)).toContain(paneId);
      });
    });
  }, 60_000);
});

describe("staying out of the way", () => {
  test("names the panes that exist when asked for one that does not", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const missing = await client.callTool({
          arguments: { paneId: "%99999" },
          name: "get_pane",
        });
        expect((missing as { isError?: boolean }).isError).toBe(true);
        // A bare refusal costs a turn to find out what to ask for instead.
        expect(toolText(missing)).toContain("%99999");
        expect(toolText(missing)).toContain("Panes on this server");
      });
    });
  }, 60_000);

  test("refuses to type into the pane it runs in", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const paneId = (await tmux.snapshot()).panes.one().id;
      await withClient(
        fixture,
        async (client) => {
          const refused = await client.callTool({
            arguments: { keys: "rm -rf /", paneId },
            name: "send_keys",
          });
          expect((refused as { isError?: boolean }).isError).toBe(true);
          expect(toolText(refused)).toContain("own terminal");

          // whoami is how an agent learns this without a failed call.
          const me = structured<{ callerPaneId: string; callerPaneIsOnThisServer: boolean }>(
            await client.callTool({ arguments: {}, name: "whoami" }),
          );
          expect(me.callerPaneId).toBe(paneId);
          expect(me.callerPaneIsOnThisServer).toBe(true);

          // And force is how it says it meant that pane after all.
          const forced = await client.callTool({
            arguments: { enter: false, force: true, keys: "harmless", paneId },
            name: "send_keys",
          });
          expect((forced as { isError?: boolean }).isError ?? false).toBe(false);
        },
        {
          TMUX: `${fixture.socketPath},${String((await tmux.daemonIdentity())?.pid ?? "")},0`,
          TMUX_PANE: paneId,
        },
      );
    });
  }, 60_000);

  test("refuses every write path into the pane it runs in", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const paneId = (await tmux.snapshot()).panes.one().id;
      await withClient(
        fixture,
        async (client) => {
          // Staged out of band: filling a buffer is not itself a write into a
          // pane, so it has to succeed for paste_buffer to have something to
          // refuse.
          await client.callTool({ arguments: { name: "guard", text: "x" }, name: "load_buffer" });

          // Empty text, and no killFirst: each probe proves the guard without
          // putting a character in the terminal or ending the process in it if
          // the guard is missing.
          const refusesWrite = async (
            tool: string,
            args: Record<string, unknown>,
          ): Promise<void> => {
            const refused = await client.callTool({ arguments: args, name: tool });
            expect((refused as { isError?: boolean }).isError).toBe(true);
            // Not merely an error: tmux refuses respawn_pane on a live pane for
            // its own reasons, which would pass an isError check while the
            // guard was still missing.
            expect(toolText(refused)).toContain("own terminal");
          };

          await refusesWrite("paste_text", { paneId, text: "" });
          await refusesWrite("paste_buffer", { name: "guard", paneId });
          await refusesWrite("respawn_pane", { paneId });

          // And force is how each one says it meant that pane after all.
          const forced = await client.callTool({
            arguments: { force: true, paneId, text: "" },
            name: "paste_text",
          });
          expect((forced as { isError?: boolean }).isError ?? false).toBe(false);
        },
        {
          TMUX: `${fixture.socketPath},${String((await tmux.daemonIdentity())?.pid ?? "")},0`,
          TMUX_PANE: paneId,
        },
      );
    });
  }, 60_000);

  test("refuses every write path into a pane a person is watching", async () => {
    await withServer(async (fixture) => {
      await withAttendedPane(fixture, async (paneId) => {
        await withClient(fixture, async (client) => {
          await client.callTool({ arguments: { name: "guard", text: "x" }, name: "load_buffer" });

          const refusesWrite = async (
            tool: string,
            args: Record<string, unknown>,
          ): Promise<void> => {
            const refused = await client.callTool({ arguments: args, name: tool });
            expect((refused as { isError?: boolean }).isError).toBe(true);
            expect(toolText(refused)).toContain("person is watching");
          };

          await refusesWrite("send_keys", { enter: false, keys: "harmless", paneId });
          await refusesWrite("paste_text", { paneId, text: "" });
          await refusesWrite("run_command", { command: "true", paneId });
          await refusesWrite("paste_buffer", { name: "guard", paneId });
          await refusesWrite("respawn_pane", { paneId });

          const forced = await client.callTool({
            arguments: { force: true, paneId, text: "" },
            name: "paste_text",
          });
          expect((forced as { isError?: boolean }).isError ?? false).toBe(false);
        });
      });
    });
  }, 60_000);

  test("refuses a cursor that belongs to a different stream", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Opens the tail, so the stream has a real position to be ahead of.
        await client.callTool({ arguments: { command: "echo one", paneId }, name: "run_command" });

        const ahead = await client.callTool({
          arguments: { cursor: 999_999_999, paneId },
          name: "observe",
        });
        expect((ahead as { isError?: boolean }).isError).toBe(true);
        // Names the cursor it was given and the remedy, so the next call is the
        // right one rather than the same one.
        expect(toolText(ahead)).toContain("999999999");
        expect(toolText(ahead)).toContain("Omit cursor");

        // The same hole, where the caller's own timeout used to hide it: a
        // clean "timed_out" reported while the pane was printing.
        const waited = await client.callTool({
          arguments: { cursor: 999_999_999, paneId, patterns: ["never-x"], timeoutMs: 1_000 },
          name: "wait_for_text",
        });
        expect((waited as { isError?: boolean }).isError).toBe(true);
        expect(toolText(waited)).toContain("Omit cursor");
      });
    });
  }, 60_000);

  test("seeds observe on an absent cursor, not on an absent tail", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // run_command opens a tail. Seeding used to be decided by whether one
        // existed, so this second caller was handed the whole retained buffer
        // and told it had not been seeded.
        await client.callTool({ arguments: { command: "echo one", paneId }, name: "run_command" });

        const seeded = structured<{ cursor: number; seeded: boolean }>(
          await client.callTool({ arguments: { paneId }, name: "observe" }),
        );
        expect(seeded.seeded).toBe(true);

        // And the cursor it hands back is one that yields only what came after.
        await client.callTool({ arguments: { command: "echo two", paneId }, name: "run_command" });
        const delta = structured<{ text: string }>(
          await client.callTool({ arguments: { cursor: seeded.cursor, paneId }, name: "observe" }),
        );
        expect(delta.text).toContain("two");
        expect(delta.text).not.toContain("one");
      });
    });
  }, 60_000);

  test("answers isCallerPane the same way from every tool that returns a pane", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const paneId = (await tmux.snapshot()).panes.one().id;
      await withClient(
        fixture,
        async (client) => {
          const callerFlag = async (
            tool: string,
            args: Record<string, unknown>,
          ): Promise<boolean> =>
            structured<{ pane: { isCallerPane: boolean } }>(
              await client.callTool({ arguments: args, name: tool }),
            ).pane.isCallerPane;

          // get_pane hands paneView the identity and has always been right.
          expect(await callerFlag("get_pane", { paneId })).toBe(true);

          // The same pane in the same instant, through tools that built their
          // view without one. The field is declared, so false reads as a fact
          // about the pane rather than about the call site.
          expect(await callerFlag("set_pane_title", { paneId, title: "probe" })).toBe(true);
          expect(await callerFlag("select_pane", { paneId })).toBe(true);
          expect(await callerFlag("resize_pane", { paneId, width: 40 })).toBe(true);
        },
        {
          TMUX: `${fixture.socketPath},${String((await tmux.daemonIdentity())?.pid ?? "")},0`,
          TMUX_PANE: paneId,
        },
      );
    });
  }, 60_000);

  test("holds a task wait to the blocking ceiling when the client has no tasks", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({
          arguments: { command: "echo ready-now", paneId },
          name: "run_command",
        });

        // Matches at once, so this asserts which ceiling was chosen rather
        // than spending it. This client declares no task capability, so the
        // SDK runs the tool and polls on its behalf: the call blocks and
        // cannot be cancelled, which is what the task ceiling is traded for.
        const result = structured<{ effectiveTimeoutMs: number; outcome: string }>(
          await client.callTool({
            arguments: { paneId, patterns: ["ready-now"], timeoutMs: 5_000_000 },
            name: "wait_for_text_task",
          }),
        );
        expect(result.outcome).toBe("matched");
        expect(result.effectiveTimeoutMs).toBe(30_000);
      });
    });
  }, 60_000);

  test("says the resource list changed when it changes it", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        let notices = 0;
        client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
          notices += 1;
        });

        const paneId = await shellPaneId(client);
        await client.callTool({ arguments: { paneId }, name: "split_pane" });
        // Longer than the coalescing window, so the notice has landed.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(notices).toBeGreaterThan(0);

        // One intent that makes a session, three windows and their panes is
        // one notice, not nine: a client refreshes the whole list per notice.
        notices = 0;
        await client.callTool({
          arguments: {
            session: "coalesced",
            windows: [{ name: "one" }, { name: "two" }, { name: "three" }],
          },
          name: "build_workspace",
        });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(notices).toBe(1);
      });
    });
  }, 60_000);

  test("resolves a session filter the way every other tool resolves one", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const first = structured<{ session: { id: string; name: string } }>(
          await client.callTool({ arguments: { name: "real" }, name: "new_session" }),
        ).session;

        // A session whose NAME is another session's ID. tmux treats a leading
        // $ as an id lookup that fails rather than falling through to names,
        // and requireSession resolves id first — so the filters must not match
        // both namespaces at once.
        await client.callTool({ arguments: { name: first.id }, name: "new_session" });

        const panes = structured<{ panes: { sessionId: string }[] }>(
          await client.callTool({ arguments: { session: first.id }, name: "list_panes" }),
        ).panes;
        expect(panes.length).toBeGreaterThan(0);
        expect([...new Set(panes.map((pane) => pane.sessionId))]).toEqual([first.id]);

        const windows = structured<{ windows: { sessionId: string }[] }>(
          await client.callTool({ arguments: { session: first.id }, name: "list_windows" }),
        ).windows;
        expect([...new Set(windows.map((window) => window.sessionId))]).toEqual([first.id]);

        // A session that does not exist is an error naming what does, not an
        // empty list an agent reads as "this session has no panes".
        const missing = await client.callTool({
          arguments: { session: "nosuchsession" },
          name: "list_panes",
        });
        expect((missing as { isError?: boolean }).isError).toBe(true);
        expect(toolText(missing)).toContain("Sessions on this server");
      });
    });
  }, 60_000);

  test("says when an error's list of alternatives is not all of them", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // Past the twelve an error will name. The list used to stop there with
        // no marker, so an agent read twelve of fifteen as all of them.
        for (let index = 0; index < 14; index += 1) {
          // eslint-disable-next-line no-await-in-loop -- each session follows the last.
          await client.callTool({
            arguments: { name: `bulk-${String(index)}` },
            name: "new_session",
          });
        }

        const missing = await client.callTool({
          arguments: { session: "nosuchsession" },
          name: "list_windows",
        });
        expect((missing as { isError?: boolean }).isError).toBe(true);
        const text = toolText(missing);
        expect(text).toContain("more");
        // And what to call to see the rest, so the failed call is the last one.
        expect(text).toContain("list_sessions");
      });
    });
  }, 120_000);

  test("reads back every resource URI it publishes", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // The sigils that make a tmux id readable — % $ @ — are exactly the
        // characters a URI path escapes, so a published id that does not
        // survive the round trip is every id, not an unlucky one.
        const { resources } = await client.listResources();
        const perObject = resources.filter((resource) => /\/(?:%25|%24|%40)/u.test(resource.uri));
        expect(perObject.length).toBeGreaterThan(0);

        for (const resource of perObject) {
          // eslint-disable-next-line no-await-in-loop -- each read follows the last.
          const read = await client.readResource({ uri: resource.uri });
          expect(read.contents.length, `${resource.uri} read back nothing`).toBeGreaterThan(0);
        }

        // And the link a tool hands back is the same string, so it resolves
        // for the same reason.
        const paneId = await shellPaneId(client);
        const link = paneContentUri(paneId);
        const viaLink = await client.readResource({ uri: link });
        expect(viaLink.contents.length).toBeGreaterThan(0);
      });
    });
  }, 60_000);

  test("refuses to run a command in a dead pane", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        const session = (await tmux.snapshot()).sessions.one().name ?? "";
        const made = structured<{ paneId: string; window: { id: string } }>(
          await client.callTool({
            arguments: { name: "doomed", session },
            name: "new_window",
          }),
        );
        // remain-on-exit is a window option, which this server cannot yet
        // reach — the library can, and the fixture needs a pane that stays
        // after its process exits.
        const window = (await tmux.snapshot()).windows.one({ id: made.window.id });
        await window.setOption("remain-on-exit", "on");

        await client.callTool({
          arguments: { enter: true, keys: "exit 7", paneId: made.paneId },
          name: "send_keys",
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const pane = structured<{ pane: { dead: boolean } }>(
          await client.callTool({ arguments: { paneId: made.paneId }, name: "get_pane" }),
        ).pane;
        expect(pane.dead).toBe(true);

        // The whole timeout used to be spent here waiting for a marker that
        // cannot be printed, and the result then claimed the command was
        // still running. A dead pane reports the command it last ran, so the
        // shell check passed it through.
        const started = Date.now();
        const refused = await client.callTool({
          arguments: { command: "echo hi", paneId: made.paneId, timeoutMs: 8_000 },
          name: "run_command",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("respawn_pane");
        expect(Date.now() - started).toBeLessThan(4_000);
      });
    });
  }, 60_000);

  test("reports a command that outran the buffer as finished", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Past the tail's byte limit, so the start marker is evicted before
        // the end marker arrives. The command still finished; only the
        // evidence of where its output began is gone.
        const result = structured<{
          exitStatus: number | null;
          missedBytes: number;
          outcome: string;
        }>(
          await client.callTool({
            arguments: {
              command:
                "i=0; while [ $i -lt 12000 ]; do echo 0123456789012345678901234567890; " +
                "i=$((i+1)); done; exit 3",
              maxLines: 5,
              paneId,
              timeoutMs: 40_000,
            },
            name: "run_command",
          }),
        );
        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(3);
        // And the output is short of what the command printed, which the
        // caller is told rather than left to infer.
        expect(result.missedBytes).toBeGreaterThan(0);
      });
    });
  }, 120_000);

  test("returns one pane per window even when the names repeat", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const built = structured<{ panes: { id: string; windowId: string }[] }>(
          await client.callTool({
            arguments: {
              session: "dup",
              windows: [{ name: "same" }, { name: "same" }, { name: "same" }],
            },
            name: "build_workspace",
          }),
        );
        expect(built.panes).toHaveLength(3);
        // tmux does not require a window name to be unique, and matching by
        // name resolved all three to the first window — so the caller was
        // handed one pane three times and invited to skip list_panes.
        expect(new Set(built.panes.map((pane) => pane.id)).size).toBe(3);
        expect(new Set(built.panes.map((pane) => pane.windowId)).size).toBe(3);
      });
    });
  }, 60_000);

  test("needs a target for a scope that has one", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // "" is a legal tmux session name, so using it as the absent-target
        // sentinel meant an untargeted call looked up a session that can
        // exist — and wrote to it.
        const refused = await client.callTool({
          arguments: { name: "@probe", scope: "session", value: "went-somewhere" },
          name: "set_option",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("target");

        const reading = await client.callTool({
          arguments: { scope: "session" },
          name: "show_options",
        });
        expect((reading as { isError?: boolean }).isError).toBe(true);
      });
    });
  }, 60_000);

  test("unsets an option so it falls back to what it inherits", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";
        await client.callTool({
          arguments: { name: "@probe", scope: "session", target: session, value: "mine" },
          name: "set_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({
              arguments: { scope: "session", target: session },
              name: "show_options",
            }),
          ).options["@probe"],
        ).toBe("mine");

        // Setting is reachable and unsetting was not, so a wrong value was
        // permanent from inside this server.
        await client.callTool({
          arguments: { name: "@probe", scope: "session", target: session },
          name: "unset_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({
              arguments: { scope: "session", target: session },
              name: "show_options",
            }),
          ).options["@probe"],
        ).toBeUndefined();
      });
    });
  }, 60_000);

  test("moves a pane between windows and back out again", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const tmux = serverFor(fixture);
        const session = (await tmux.snapshot()).sessions.one().name ?? "";
        const home = structured<{ paneId: string; window: { id: string } }>(
          await client.callTool({
            arguments: { name: "home", session },
            name: "new_window",
          }),
        );
        const guest = structured<{ paneId: string; window: { id: string } }>(
          await client.callTool({
            arguments: { name: "guest", session },
            name: "new_window",
          }),
        );

        // The one topology operation with no path: a pane could be made,
        // destroyed, and exchanged in place, but not moved into another
        // window. Joining keeps the pane and what runs in it.
        const joined = structured<{ pane: { id: string; windowId: string } }>(
          await client.callTool({
            arguments: { paneId: guest.paneId, windowId: home.window.id },
            name: "move_pane",
          }),
        ).pane;
        expect(joined.id).toBe(guest.paneId);
        expect(joined.windowId).toBe(home.window.id);

        // And back out into a window of its own, by naming no destination.
        const broken = structured<{ pane: { id: string; windowId: string } }>(
          await client.callTool({
            arguments: { paneId: guest.paneId, windowName: "extracted" },
            name: "move_pane",
          }),
        ).pane;
        expect(broken.id).toBe(guest.paneId);
        expect(broken.windowId).not.toBe(home.window.id);
      });
    });
  }, 60_000);

  test("reports the socket it is actually driving", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const info = structured<{ socketPath: string | null }>(
          await client.callTool({ arguments: {}, name: "server_info" }),
        );
        const asked = structured<{ value: string }>(
          await client.callTool({
            arguments: { format: "#{socket_path}" },
            name: "display_message",
          }),
        );
        // The two used to be able to disagree: this read the constructor
        // argument while display_message asked tmux. They now have one source.
        //
        // The case that made it null — a server reached on the default socket,
        // where nothing was passed in — cannot be reproduced here, because the
        // suite only ever runs against sockets it owns. This pins the
        // agreement rather than that case.
        expect(info.socketPath).toBe(asked.value);
        expect(info.socketPath).toBe(fixture.socketPath);
      });
    });
  }, 60_000);

  test("says when a pane did not start where it was asked to", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";
        // tmux chdirs in the forked child and falls back silently, so this
        // succeeds and the pane is somewhere else entirely.
        const made = await client.callTool({
          arguments: {
            name: "elsewhere",
            session,
            startDirectory: "/definitely-not-a-directory-xyz",
          },
          name: "new_window",
        });
        expect((made as { isError?: boolean }).isError ?? false).toBe(false);
        const text = toolText(made);
        expect(text).toContain("was not used");
        expect(text).toContain("/definitely-not-a-directory-xyz");
      });
    });
  }, 60_000);

  test("splits a pane into the directory that pane is in", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        await client.callTool({ arguments: { command: "cd /etc", paneId }, name: "run_command" });
        // run_command runs in a subshell, so move the pane itself.
        await client.callTool({
          arguments: { enter: true, keys: "cd /etc", paneId },
          name: "send_keys",
        });
        await new Promise((resolve) => setTimeout(resolve, 700));

        const split = structured<{ pane: { cwd: string } }>(
          await client.callTool({ arguments: { paneId }, name: "split_pane" }),
        ).pane;
        // tmux consults the client and then the session, never the pane being
        // split, so this used to land in the session's directory.
        expect(split.cwd).toBe("/etc");

        // Naming one still wins over the inherited default.
        const named = structured<{ pane: { cwd: string } }>(
          await client.callTool({
            arguments: { paneId, startDirectory: "/tmp" },
            name: "split_pane",
          }),
        ).pane;
        expect(named.cwd).toBe("/tmp");
      });
    });
  }, 60_000);

  test("says when a layout string was accepted and ignored", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";
        const wide = structured<{ paneId: string; window: { id: string } }>(
          await client.callTool({ arguments: { name: "wide", session }, name: "new_window" }),
        );
        await client.callTool({ arguments: { paneId: wide.paneId }, name: "split_pane" });
        const twoPane = structured<{ window: { layout: string } }>(
          await client.callTool({
            arguments: { layout: "even-horizontal", windowId: wide.window.id },
            name: "select_layout",
          }),
        ).window.layout;

        const narrow = structured<{ window: { id: string } }>(
          await client.callTool({ arguments: { name: "narrow", session }, name: "new_window" }),
        ).window;

        // tmux exits 0 for a layout describing a different set of panes and
        // changes nothing, so the call looks like it worked.
        const ignored = await client.callTool({
          arguments: { layout: twoPane, windowId: narrow.id },
          name: "select_layout",
        });
        expect(toolText(ignored)).toContain("was not applied");

        // The quiet half: a layout that does apply says nothing, or the notice
        // is noise on every call rather than a signal.
        const applied = await client.callTool({
          arguments: { layout: "even-vertical", windowId: wide.window.id },
          name: "select_layout",
        });
        expect(toolText(applied)).not.toContain("was not applied");
      });
    });
  }, 60_000);

  test("lists the hooks that run, and counts the rest", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const shown = structured<{ hooks: Record<string, string>; unset: number }>(
          await client.callTool({ arguments: {}, name: "show_hooks" }),
        );
        // tmux reports its whole table, nearly all of it empty; the question is
        // which hooks run.
        expect(shown.unset).toBeGreaterThan(0);
        for (const [name, command] of Object.entries(shown.hooks)) {
          expect(command, `${name} was listed with no command`).not.toBe("");
        }
      });
    });
  }, 60_000);

  test("tells a mistyped format from an empty field", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);

        // tmux prints nothing for a name it has never heard of and exits 0, so
        // this used to be the same answer as a field that is genuinely empty.
        const typo = await client.callTool({
          arguments: { format: "#{nonexistent_field_xyz}", paneId, target: paneId },
          name: "display_message",
        });
        expect(toolText(typo)).toContain("nonexistent_field_xyz");

        // The quiet half, twice over. A format that resolves says nothing...
        const resolved = await client.callTool({
          arguments: { format: "#{pane_id}", target: paneId },
          name: "display_message",
        });
        expect(toolText(resolved)).toContain(paneId);
        expect(toolText(resolved)).not.toContain("has no field");

        // ...and a real field that is merely empty is not called a typo.
        const empty = await client.callTool({
          arguments: { format: "#{pane_start_command}", target: paneId },
          name: "display_message",
        });
        expect(toolText(empty)).not.toContain("has no field");

        // An expression is not a name, and rejecting a working format would be
        // worse than the silence this replaces.
        const expression = await client.callTool({
          arguments: { format: "#{?pane_dead,dead,live}", target: paneId },
          name: "display_message",
        });
        expect(toolText(expression)).not.toContain("has no field");

        // A bad name beside a good one resolves to something that reads like a
        // value — "%0-" looks like an answer rather than a mistake — so a
        // result being non-empty is not evidence that all of it resolved.
        const partial = await client.callTool({
          arguments: { format: "#{pane_id}-#{nonexistent_field_xyz}", target: paneId },
          name: "display_message",
        });
        expect(toolText(partial)).toContain("nonexistent_field_xyz");

        // And the quiet half of that: two names that both resolve say nothing.
        const both = await client.callTool({
          arguments: { format: "#{pane_id}-#{pane_index}", target: paneId },
          name: "display_message",
        });
        expect(toolText(both)).not.toContain("has no field");
      });
    });
  }, 60_000);

  test("reaches the options a session actually inherits", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const session = (await serverFor(fixture).snapshot()).sessions.one().name ?? "";

        // A session that has set nothing reports nothing, and that used to be
        // the whole answer — while the values governing it live in the global
        // scopes, which nothing could reach.
        const own = structured<{ options: Record<string, string> }>(
          await client.callTool({
            arguments: { scope: "session", target: session },
            name: "show_options",
          }),
        ).options;

        const inherited = structured<{ options: Record<string, string> }>(
          await client.callTool({ arguments: { scope: "global-session" }, name: "show_options" }),
        ).options;
        expect(Object.keys(inherited).length).toBeGreaterThan(Object.keys(own).length);
        // default-shell decides what a new pane runs, and run_command refuses a
        // shell it cannot address; history-limit decides how far capture_pane's
        // negative start reaches. Both are global SESSION options — checked
        // against tmux rather than assumed, since guessing the scope is how a
        // present option reads as missing.
        expect(inherited["default-shell"]).toBeDefined();
        expect(inherited["history-limit"]).toBeDefined();

        // The window table is a different set: remain-on-exit lives there, and
        // is what keeps a pane whose process has exited.
        const windows = structured<{ options: Record<string, string> }>(
          await client.callTool({ arguments: { scope: "global-window" }, name: "show_options" }),
        ).options;
        expect(windows["remain-on-exit"]).toBeDefined();

        // Writable and undoable at the same scope.
        await client.callTool({
          arguments: { name: "@probe", scope: "global-session", value: "inherited" },
          name: "set_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({ arguments: { scope: "global-session" }, name: "show_options" }),
          ).options["@probe"],
        ).toBe("inherited");
        await client.callTool({
          arguments: { name: "@probe", scope: "global-session" },
          name: "unset_option",
        });
        expect(
          structured<{ options: Record<string, string> }>(
            await client.callTool({ arguments: { scope: "global-session" }, name: "show_options" }),
          ).options["@probe"],
        ).toBeUndefined();

        // A global scope names no object, so it must not demand a target.
        const noTarget = await client.callTool({
          arguments: { scope: "global-window" },
          name: "show_options",
        });
        expect((noTarget as { isError?: boolean }).isError ?? false).toBe(false);
      });
    });
  }, 60_000);

  test("declares an open world wherever it runs a command", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const byName = new Map(
          (await client.listTools()).tools.map((tool) => [tool.name, tool.annotations]),
        );

        // openWorldHint is one of the signals a host uses to decide what it may
        // approve without asking, and the tier cannot separate these: all of
        // them are legitimately mutating. Every tool taking a shellCommand does
        // whatever that command does, which is as unknowable from here as what
        // send_keys types.
        for (const name of [
          "send_keys",
          "run_command",
          "new_session",
          "new_window",
          "split_pane",
          "respawn_pane",
          "build_workspace",
          "display_message",
          "pipe_pane",
        ]) {
          expect(byName.get(name)?.openWorldHint, `${name} hides an open world`).toBe(true);
        }

        // The quiet half: a tool that only rearranges tmux does not claim one,
        // or the hint stops meaning anything.
        for (const name of ["select_pane", "rename_window", "list_panes", "capture_pane"]) {
          expect(byName.get(name)?.openWorldHint, `${name} claims an open world`).not.toBe(true);
        }

        // A spawn creates rather than ends, and a host needs those apart.
        expect(byName.get("new_window")?.destructiveHint).toBe(false);
      });
    });
  }, 60_000);

  test("lets go of a session's connection once nothing is reading it", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const controlClients = async (): Promise<number> =>
        (await tmux.cmd("list-clients", ["-F", "#{client_control_mode}"], { target: null })).filter(
          (line) => line === "1",
        ).length;

      const hub = new LiveHub(tmux, { lingerMs: 2_000 });
      try {
        const snapshot = await tmux.snapshot();
        const tail = await hub.tail(snapshot.sessions.one().id, snapshot.panes.one().id);
        expect(tail).toBeDefined();
        expect(await controlClients()).toBeGreaterThan(0);

        // Read early in the linger rather than at its start. The sweep is armed
        // when the tail is created, so this read leaves it short of the
        // threshold on the first pass — which is the case the reschedule has to
        // get right, and the one a read taken at the same instant hides,
        // because timer overshoot alone carries that past the threshold.
        await new Promise((resolve) => setTimeout(resolve, 200));
        tail?.read(undefined);

        // Nothing reads it from here. The close path used to refuse to run
        // while the link held any tail, and nothing ever removed one — so for
        // any session a tool had observed, this connection was held for the
        // life of the process and tmux counted it the whole time.
        //
        const started = Date.now();
        let remaining = 1;
        while (Date.now() - started < 8_000 && remaining > 0) {
          // eslint-disable-next-line no-await-in-loop -- each check follows the last.
          await new Promise((resolve) => setTimeout(resolve, 50));
          // eslint-disable-next-line no-await-in-loop -- and reads after waiting.
          remaining = await controlClients();
        }
        expect(remaining).toBe(0);

        // And promptly. The sweep is armed when the tail is created and the
        // tail is read just after, so it is always a little short of the
        // threshold on the first pass — coming back a whole linger later each
        // time took twice as long to release as it should.
        // Roughly one linger after the last read. Coming back a whole linger
        // from the sweep instead of from the read made it two.
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        await hub.close();
      }
    });
  }, 60_000);

  test("keeps a connection that something is still reading", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const hub = new LiveHub(tmux, { lingerMs: 200 });
      try {
        const snapshot = await tmux.snapshot();
        const tail = await hub.tail(snapshot.sessions.one().id, snapshot.panes.one().id);
        expect(tail).toBeDefined();

        // The quiet half: reading across the linger keeps it. A sweep that
        // dropped a tail somebody was using would be worse than the leak.
        for (let round = 0; round < 8; round += 1) {
          // eslint-disable-next-line no-await-in-loop -- each read follows the last.
          await new Promise((resolve) => setTimeout(resolve, 150));
          tail?.read(undefined);
        }
        const clients = (
          await tmux.cmd("list-clients", ["-F", "#{client_control_mode}"], { target: null })
        ).filter((line) => line === "1").length;
        expect(clients).toBeGreaterThan(0);
      } finally {
        await hub.close();
      }
    });
  }, 60_000);

  test("says the list changed when another client changes it", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        let notices = 0;
        client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
          notices += 1;
        });

        // Browsing is what starts the watch: a server nobody browses holds no
        // connection for this.
        await client.listResources();
        await new Promise((resolve) => setTimeout(resolve, 800));
        notices = 0;

        // Not through this server. A person in a terminal, or another agent on
        // the same tmux server, changes the list too — and a client that
        // believes listChanged refreshes only on notice.
        const session = (await tmux.snapshot()).sessions.one();
        await session.newWindow({ name: "made-elsewhere" });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(notices).toBeGreaterThan(0);
      });
    });
  }, 60_000);

  test("captures a pane past what it keeps, and writes a buffer out", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const log = join(await makeTestDirectory("ltx-pipe-"), "captured.log");

        await client.callTool({
          arguments: { paneId, shellCommand: `cat >> ${log}` },
          name: "pipe_pane",
        });

        // More than a read-back path would keep, which is the case this exists
        // for: the earliest output is gone before anything asks for it.
        await client.callTool({
          arguments: {
            command: "i=0; while [ $i -lt 3000 ]; do echo piped-$i; i=$((i+1)); done",
            maxLines: 1,
            paneId,
            timeoutMs: 40_000,
          },
          name: "run_command",
        });
        await client.callTool({ arguments: { paneId }, name: "pipe_pane" });

        const captured = await readFile(log, "utf8");
        expect(captured).toContain("piped-0");
        expect(captured).toContain("piped-2999");
        // toggle is tmux's -o, and tmux destroys the open pipe before honouring
        // it — so against a pane already being piped it stops the capture and
        // opens nothing, rather than leaving the first pipe alone.
        const other = join(await makeTestDirectory("ltx-pipe2-"), "second.log");
        const started = structured<{ piping: boolean }>(
          await client.callTool({
            arguments: { paneId, shellCommand: `cat >> ${log}` },
            name: "pipe_pane",
          }),
        );
        expect(started.piping).toBe(true);
        const toggled = structured<{ piping: boolean }>(
          await client.callTool({
            arguments: { paneId, shellCommand: `cat >> ${other}`, toggle: true },
            name: "pipe_pane",
          }),
        );
        // The caller that stopped somebody's capture is the one that most needs
        // to know it did. Reporting the request back said piping either way.
        expect(toggled.piping).toBe(false);
        await client.callTool({
          arguments: { command: "echo after-toggle", paneId, timeoutMs: 20_000 },
          name: "run_command",
        });
        expect(existsSync(other)).toBe(false);

        // And a buffer goes to a file without coming back through the caller.
        const out = join(await makeTestDirectory("ltx-save-"), "buffer.txt");
        await client.callTool({
          arguments: { name: "outgoing", text: "kept out of the reply" },
          name: "load_buffer",
        });
        await client.callTool({
          arguments: { name: "outgoing", path: out },
          name: "save_buffer",
        });
        expect(await readFile(out, "utf8")).toContain("kept out of the reply");
      });
    });
  }, 120_000);

  test("names every tool it offers in the README", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          // Six tools reached a release undocumented, because nothing checked.
          // A tool an agent cannot find is one the server may as well not
          // offer, and the README is where a person looks before installing.
          const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
          const missing = (await client.listTools()).tools
            .map((tool) => tool.name)
            .filter((name) => !readme.includes(`\`${name}\``));
          expect(missing).toEqual([]);
        },
        { LIBTMUX_SAFETY: "destructive" },
      );
    });
  }, 60_000);

  test("offers only reading tools under the readonly tier", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toContain("list_panes");
          // Hidden rather than refused: a tool an agent cannot see is one it
          // cannot spend a turn being denied.
          expect(names).not.toContain("display_message");
          expect(names).not.toContain("pipe_pane");
          expect(names).not.toContain("send_keys");
          expect(names).not.toContain("kill_pane");
          expect(client.getInstructions() ?? "").toContain("Safety: readonly");
        },
        { LIBTMUX_SAFETY: "readonly" },
      );
    });
  }, 60_000);

  test("does not execute format commands under the readonly tier", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const directory = await makeTestDirectory("ltx-format-command-");
          const marker = join(directory, "executed");
          const attempted = await client.callTool({
            arguments: { format: `#(printf ran > ${shellQuote(marker)})` },
            name: "display_message",
          });

          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(existsSync(marker)).toBe(false);
          expect((attempted as { isError?: boolean }).isError).toBe(true);
        },
        { LIBTMUX_SAFETY: "readonly" },
      );
    });
  }, 60_000);

  test("keeps respawn_pane from killing a process below the destructive tier", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Something for killFirst to end. Without a live process the respawn
        // is uncontroversial and would pass whatever the tier.
        await client.callTool({
          arguments: { command: "sleep 120", paneId, timeoutMs: 1_000 },
          name: "run_command",
        });

        const refused = await client.callTool({
          arguments: { killFirst: true, paneId },
          name: "respawn_pane",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        // kill_pane is hidden at this tier, and killFirst reached the same end
        // by another road.
        expect(toolText(refused)).toContain("destructive");

        // The recovery path this tool exists for is untouched: no killFirst,
        // and tmux refuses on its own terms rather than on the tier.
        const alive = await client.callTool({ arguments: { paneId }, name: "respawn_pane" });
        expect(toolText(alive)).not.toContain("destructive");
      });
    });
  }, 60_000);

  test("allows respawn_pane to kill under the destructive tier", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const paneId = await shellPaneId(client);
          await client.callTool({
            arguments: { command: "sleep 120", paneId, timeoutMs: 1_000 },
            name: "run_command",
          });
          const done = await client.callTool({
            arguments: { killFirst: true, paneId },
            name: "respawn_pane",
          });
          expect((done as { isError?: boolean }).isError ?? false).toBe(false);
        },
        { LIBTMUX_SAFETY: "destructive" },
      );
    });
  }, 60_000);

  test("offers killing only under the destructive tier", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("kill_pane");
        },
        { LIBTMUX_SAFETY: "destructive" },
      );
    });
  }, 60_000);
});

describe("browsing", () => {
  test("lists resources and templates a client can show a person", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const templates = (await client.listResourceTemplates()).resourceTemplates.map(
          (entry) => entry.uriTemplate,
        );
        expect(templates).toContain("tmux://panes/{paneId}");
        expect(templates).toContain("tmux://panes/{paneId}/content");

        const listed = (await client.listResources()).resources.map((entry) => entry.uri);
        expect(listed).toContain("tmux://sessions");

        const read = await client.readResource({ uri: "tmux://sessions" });
        const first = read.contents[0];
        expect(first?.mimeType).toBe("application/json");
        expect(JSON.parse(String((first as { text: string }).text))).toBeArray();
      });
    });
  }, 60_000);

  test("completes a pane id, which is the only place MCP allows it", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await firstPaneId(client);
        const completion = await client.complete({
          argument: { name: "paneId", value: "%" },
          ref: { type: "ref/resource", uri: "tmux://panes/{paneId}" },
        });
        expect(completion.completion.values).toContain(paneId);
      });
    });
  }, 60_000);

  test("pushes an update when a subscribed pane prints", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await firstPaneId(client);
        const uri = `tmux://panes/${encodeURIComponent(paneId)}/content`;

        const updates: string[] = [];
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
          updates.push(notification.params.uri);
        });
        await client.subscribeResource({ uri });
        await client.callTool({
          arguments: { keys: "printf 'subscribed\\n'", paneId },
          name: "send_keys",
        });

        const deadline = Date.now() + 20_000;
        while (updates.length === 0 && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop -- each check follows the last.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(updates).toContain(uri);

        await client.unsubscribeResource({ uri });
      });
    });
  }, 60_000);

  test("offers prompts that name the cheap tool for each job", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
        expect(names).toContain("run-and-check");
        expect(names).toContain("watch-until");

        const rendered = await client.getPrompt({
          arguments: { expect: "DONE", paneId: "%0" },
          name: "watch-until",
        });
        const text = rendered.messages
          .map((message) => (message.content.type === "text" ? message.content.text : ""))
          .join("\n");
        expect(text).toContain("wait_for_text");
        expect(text).toContain("Never loop capture_pane");

        const command = await client.getPrompt({
          arguments: { command: "make", paneId: "%0" },
          name: "run-and-check",
        });
        const commandText = command.messages
          .map((message) => (message.content.type === "text" ? message.content.text : ""))
          .join("\n");
        expect(commandText).toContain("wait_for_text");
        expect(commandText).toContain("C-c");
        expect(commandText).not.toContain("call again to keep waiting");
      });
    });
  }, 60_000);
});

describe("building", () => {
  test("creates a session and all its windows in one call", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const built = structured<{
          panes: { id: string; windowName: string }[];
          sessionId: string;
        }>(
          await client.callTool({
            arguments: {
              session: "built",
              windows: [{ name: "edit" }, { name: "test" }, { name: "logs" }],
            },
            name: "build_workspace",
          }),
        );
        // Every pane id comes back, so nothing needs a list_panes afterwards.
        expect(built.panes.map((pane) => pane.windowName)).toEqual(["edit", "test", "logs"]);
        for (const pane of built.panes) expect(pane.id).toStartWith("%");
      });
    });
  }, 60_000);

  test("refuses a session name already in use rather than making a second one", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const refused = await client.callTool({
          arguments: { session: fixture.sessionName, windows: [{ name: "one" }] },
          name: "build_workspace",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("already exists");
      });
    });
  }, 60_000);
});

describe("cleaning up after itself", () => {
  test("drops its control connections when an embedded client goes away", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const controlClients = async (): Promise<number> =>
        (await tmux.clients()).toArray().filter((entry) => entry.controlMode === true).length;

      // In-process, not over stdio: a stdio server dies with its transport and
      // takes its `tmux -C attach` child along, so that case cannot show a leak
      // whether or not one exists. An embedded host outlives its client.
      const before = await controlClients();
      const mcp = createTmuxMcpServer(tmux, { environment: {} });
      const client = new Client({ name: "embedded", version: "0.0.0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);

      const paneId = (await tmux.snapshot()).panes.one().id;
      // Starts a watch, which is what opens the connection.
      await client.callTool({ arguments: { paneId }, name: "observe" });
      expect(await controlClients()).toBeGreaterThan(before);

      await client.close();

      // Bounded for liveness: closing is asynchronous, so a connection that is
      // going away has not necessarily gone yet.
      const deadline = Date.now() + 10_000;
      let remaining = await controlClients();
      while (remaining > before && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- each check follows the last.
        await new Promise((resolve) => setTimeout(resolve, 50));
        // eslint-disable-next-line no-await-in-loop -- and each read follows its wait.
        remaining = await controlClients();
      }
      expect(remaining).toBe(before);
    });
  }, 60_000);
});

describe("the library underneath", () => {
  test("registers against a real server without a transport", async () => {
    await withServer(async (fixture) => {
      const mcp = createTmuxMcpServer(serverFor(fixture), { environment: {} });
      expect(typeof mcp.connect).toBe("function");
    });
  }, 40_000);
});
