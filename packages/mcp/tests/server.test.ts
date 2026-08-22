// The library's real-tmux fixture harness reaches into its internals, so it is
// unpublished and an in-repo consumer reaches across packages for it by path.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { createTmuxMcpServer } from "../src/server.js";
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
        // fish rejects `m=x` outright, so framing a command for it produces a
        // syntax error and a wait that runs to its deadline against one.
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

  test("offers only reading tools under the readonly tier", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toContain("list_panes");
          // Hidden rather than refused: a tool an agent cannot see is one it
          // cannot spend a turn being denied.
          expect(names).not.toContain("send_keys");
          expect(names).not.toContain("kill_pane");
          expect(client.getInstructions() ?? "").toContain("Safety: readonly");
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
