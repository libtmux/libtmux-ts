import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, test } from "bun:test";

import {
  shellPaneId,
  structured,
  toolText,
  withClient,
  withServer,
} from "./support/server_harness.js";

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
  test("refuses a NUL byte before sending shell input", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const answer = await client.callTool({
          arguments: { command: "printf before\0printf after", paneId },
          name: "run_command",
        });

        expect((answer as { isError?: boolean }).isError).toBe(true);
        expect(toolText(answer)).toContain("NUL");
      });
    });
  }, 60_000);

  test("submits framing through each supported interactive shell", async () => {
    const shells = [
      { command: "sh", name: "sh" },
      { command: "bash --noprofile --norc", name: "bash" },
      { command: "dash", name: "dash" },
      { command: "zsh -f", name: "zsh" },
    ].filter(({ name }) => Bun.which(name) !== null);

    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        for (const shell of shells) {
          // eslint-disable-next-line no-await-in-loop -- each shell owns its pane and result.
          const paneId = await shellPaneId(client, shell.command);
          // eslint-disable-next-line no-await-in-loop -- this assertion names the shell that failed.
          const answer = await client.callTool({
            arguments: {
              command: `cat <<'LTX'\n${shell.name}-heredoc\nLTX\nprintf '${shell.name}-ok\\n'`,
              paneId,
              timeoutMs: 2_000,
            },
            name: "run_command",
          });
          const result = structured<{
            exitStatus: number;
            outcome: string;
            output: string;
          }>(answer);
          expect(result, shell.name).toMatchObject({
            exitStatus: 0,
            outcome: "completed",
            output: `${shell.name}-heredoc\n${shell.name}-ok`,
          });
        }
      });
    });
  }, 60_000);

  test("reports what a command printed, not the pane's echo of it", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // The trap: the text waited for is also in the command being sent.
        const answer = await client.callTool({
          arguments: { command: "echo hello", paneId },
          name: "run_command",
        });
        const result = structured<{
          exitStatus: number;
          outcome: string;
          output: string;
        }>(answer);
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

  test("survives trailing comments and inherited errexit", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const commented = structured<{ exitStatus: number; output: string }>(
          await client.callTool({
            arguments: { command: "printf 'comment-ok\\n' # trailing", paneId },
            name: "run_command",
          }),
        );
        expect(commented).toMatchObject({
          exitStatus: 0,
          output: "comment-ok",
        });

        await client.callTool({
          arguments: { keys: "set -e", paneId },
          name: "send_keys",
        });
        const failed = structured<{
          exitStatus: number;
          outcome: string;
          output: string;
        }>(
          await client.callTool({
            arguments: {
              command: "printf 'before-failure\\n'; false; printf 'SHOULD-NOT-RUN\\n'",
              paneId,
            },
            name: "run_command",
          }),
        );
        expect(failed).toMatchObject({
          exitStatus: 1,
          outcome: "completed",
          output: "before-failure",
        });

        const after = structured<{ output: string }>(
          await client.callTool({
            arguments: { command: "printf 'still-alive\\n'", paneId },
            name: "run_command",
          }),
        );
        expect(after.output).toBe("still-alive");
      });
    });
  }, 60_000);

  test("does not expose its completion marker to the command", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        const answer = await client.callTool({
          arguments: {
            command:
              `printf '%s\n' "\${m}_E 0 \${m}_D" "\${1}_E 0 \${1}_D"; ` +
              `printf 'after-forge\n'; exit 7`,
            paneId,
          },
          name: "run_command",
        });
        const result = structured<{
          exitStatus: number;
          outcome: string;
          output: string;
        }>(answer);

        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(7);
        expect(result.output).toContain("after-forge");
      });
    });
  }, 60_000);

  test("does not expose its completion marker through Bash history", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client, "bash --noprofile --norc");
        await client.callTool({
          arguments: { keys: "HISTCONTROL=", paneId },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: {
            command:
              `entry=$(history 1); ` +
              `marker=$(printf '%s\n' "$entry" | sed -n 's/.*_marker=\\(ltx[0-9a-f]*\\);.*/\\1/p'); ` +
              `printf '%s_E 0 %s_D\n' "$marker" "$marker"; ` +
              `printf 'after-history-forge\n'; exit 7`,
            paneId,
          },
          name: "run_command",
        });
        const result = structured<{
          exitStatus: number;
          outcome: string;
          output: string;
        }>(answer);

        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(7);
        expect(result.output).toContain("after-history-forge");
      });
    });
  }, 60_000);

  test("does not expose its completion marker to zsh TRAPDEBUG", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client, "zsh -f");
        await client.callTool({
          arguments: {
            keys:
              `TRAPDEBUG() { local n; for n in \${(k)parameters}; do ` +
              `case $n in __ltx_*_marker) leak=\${(P)n};; esac; done; }`,
            paneId,
          },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: {
            command:
              `print -r -- "\${leak}_E 0 \${leak}_D"; ` + `print -r -- after-debug-forge; exit 7`,
            paneId,
          },
          name: "run_command",
        });
        const result = structured<{
          exitStatus: number;
          outcome: string;
          output: string;
        }>(answer);

        expect(result.outcome).toBe("completed");
        expect(result.exitStatus).toBe(7);
        expect(result.output).toContain("after-debug-forge");
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
          arguments: {
            command: "printf 'readonly-ok\\n'",
            paneId,
            timeoutMs: 2_000,
          },
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
        expect(toolText(answer)).toContain("enter=false");
        expect(toolText(answer)).toContain("force=true");
      });
    });
  }, 60_000);

  test("does not recommend filtered tools for a command that is still running", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const paneId = await shellPaneId(client);
          const answer = await client.callTool({
            arguments: { command: "sleep 30", paneId, timeoutMs: 1_500 },
            name: "run_command",
          });
          expect(toolText(answer)).toContain("still running");
          expect(toolText(answer)).not.toContain("wait_for_text");
          expect(toolText(answer)).not.toContain("send_keys");
        },
        { LIBTMUX_MCP_TOOLS: "build_workspace,run_command" },
      );
    });
  }, 60_000);

  test("refuses a shell whose syntax the framing is not written in even when forced", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const built = structured<{ panes: { id: string }[] }>(
          await client.callTool({
            arguments: {
              session: "fishy",
              windows: [{ name: "f", shellCommand: "fish" }],
            },
            name: "build_workspace",
          }),
        );
        const paneId = built.panes[0]?.id ?? "";
        const refused = await client.callTool({
          arguments: {
            command: "echo hi",
            force: true,
            paneId,
            timeoutMs: 1_000,
          },
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

  test("reserves a pane until a timed-out command finishes", async () => {
    await withServer(async (fixture) => {
      const exercise = async (client: Client, live: boolean): Promise<void> => {
        const paneId = await shellPaneId(client);
        const warm = structured<{ outcome: string }>(
          await client.callTool({
            arguments: { command: "true", paneId, timeoutMs: 5_000 },
            name: "run_command",
          }),
        );
        expect(warm.outcome).toBe("completed");
        await client.callTool({
          arguments: { name: "late", text: "late" },
          name: "load_buffer",
        });
        const timedOut = await client.callTool({
          arguments: { command: "sleep 4", paneId, timeoutMs: 1_000 },
          name: "run_command",
        });
        expect(
          structured<{ outcome: string; stillRunning: boolean }>(timedOut),
          toolText(timedOut),
        ).toMatchObject({ outcome: "timed_out", stillRunning: true });
        const refused = await client.callTool({
          arguments: { command: "echo late", paneId, timeoutMs: 1_000 },
          name: "run_command",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("sleep");
        expect(toolText(refused)).toContain("enter=false");
        expect(toolText(refused)).toContain("force=true");
        expect(toolText(timedOut).includes("wait_for_text")).toBe(live);
        expect(toolText(refused).includes("wait_for_text")).toBe(live);
        await Promise.all(
          (
            [
              ["send_keys", { keys: "C-c", paneId }],
              ["paste_text", { paneId, text: "late" }],
              ["paste_buffer", { name: "late", paneId }],
            ] as const
          ).map(async ([name, arguments_]) => {
            const write = await client.callTool({
              arguments: arguments_,
              name,
            });
            expect((write as { isError?: boolean }).isError, name).toBe(true);
            expect(toolText(write)).toContain("sleep");
          }),
        );

        await new Promise((resolve) => setTimeout(resolve, 3_500));
        const available = structured<{ outcome: string }>(
          await client.callTool({
            arguments: { command: "true", paneId, timeoutMs: 1_000 },
            name: "run_command",
          }),
        );
        expect(available.outcome).toBe("completed");
      };

      await withClient(fixture, (client) => exercise(client, true));
      await withClient(fixture, (client) => exercise(client, false), {
        LIBTMUX_MCP_LIVE: "0",
      });
    });
  }, 60_000);

  test("holds command and wait output to the operator line ceiling", async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const paneId = await shellPaneId(client);
          const command = structured<{ droppedLines: number; output: string }>(
            await client.callTool({
              arguments: {
                command: "printf 'one\\ntwo\\nthree\\nfour\\n'",
                maxLines: 999,
                paneId,
              },
              name: "run_command",
            }),
          );
          expect(command.output).toBe("three\nfour");
          expect(command.droppedLines).toBe(2);

          const { cursor } = structured<{ cursor: string }>(
            await client.callTool({ arguments: { paneId }, name: "observe" }),
          );
          await client.callTool({
            arguments: {
              keys: "(sleep 1; printf 'one\\ntwo\\nthree\\nfour\\n') &",
              paneId,
            },
            name: "send_keys",
          });
          const waitAnswer = await client.callTool({
            arguments: {
              maxLines: 999,
              paneId,
              patterns: ["never-printed-by-this"],
              timeoutMs: 2_000,
              cursor,
            },
            name: "wait_for_text",
          });
          expect((waitAnswer as { isError?: boolean }).isError ?? false, toolText(waitAnswer)).toBe(
            false,
          );
          const waited = structured<{ droppedLines: number; output: string }>(waitAnswer);
          expect(waited.output.split("\n").length).toBeLessThanOrEqual(2);
          expect(waited.droppedLines).toBeGreaterThan(0);
        },
        { LIBTMUX_MCP_MAX_RESULT_LINES: "2" },
      );
    });
  }, 60_000);
});
