import { describe, expect, test } from "bun:test";

import {
  cursorOffset,
  firstPaneId,
  serverFor,
  shellPaneId,
  structured,
  toolText,
  withClient,
  withServer,
} from "./support/server_harness.js";

describe("waiting", () => {
  test("keeps what arrived during a wait that did not match", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);
        // Start the stream, so what follows is inside the wait's own window.
        await client.callTool({ arguments: { paneId }, name: "observe" });
        await client.callTool({
          arguments: {
            keys: "(sleep 1; printf 'something-else\\n') &",
            paneId,
          },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: {
            paneId,
            patterns: ["never-printed-by-this"],
            timeoutMs: 4_000,
          },
          name: "wait_for_text",
        });
        const result = structured<{
          cursor: string;
          outcome: string;
          output: string;
        }>(answer);
        // The whole point: a timeout is evidence, not an empty hand.
        expect(result.outcome).toBe("timed_out");
        expect(result.output).toContain("something-else");
        expect(cursorOffset(result.cursor)).toBeGreaterThan(0);
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
          arguments: {
            paneId,
            patterns: ["never-printed-by-this"],
            timeoutMs: 1_500,
          },
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
          arguments: {
            paneId,
            patterns: ["migration-complete"],
            timeoutMs: 1_500,
          },
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
        }).toEqual({
          alreadyOnScreen: true,
          matched: null,
          outcome: "timed_out",
        });
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
          arguments: {
            paneId,
            patterns: ["never-printed-anywhere"],
            timeoutMs: 1_500,
          },
          name: "wait_for_text",
        });
        expect(structured<{ alreadyOnScreen: boolean }>(answer).alreadyOnScreen).toBe(false);
      });
    });
  }, 90_000);

  test("reports a pane that died mid-wait rather than waiting out the deadline", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        // Keep both the session and the exited pane: existence alone must not
        // make a retained dead pane look capable of printing later.
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
        const pane = (await tmux.snapshot()).panes.first({ id: paneId });
        if (pane?.window === undefined) throw new Error(`No window for ${paneId}`);
        await pane.window.setOption("remain-on-exit", "on");
        await client.callTool({
          arguments: { keys: "sleep 1; exit", paneId },
          name: "send_keys",
        });

        const started = Date.now();
        const answer = await client.callTool({
          arguments: {
            paneId,
            patterns: ["never-printed-anywhere"],
            timeoutMs: 30_000,
          },
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
          arguments: {
            keys: "(sleep 1; printf 'from-elsewhere\\n') &",
            paneId,
          },
          name: "send_keys",
        });
        const answer = await client.callTool({
          arguments: {
            paneId,
            patterns: ["from-elsewhere"],
            timeoutMs: 20_000,
          },
          name: "wait_for_text",
        });
        const result = structured<{ matched: string; outcome: string }>(answer);
        expect(result.outcome).toBe("matched");
        expect(result.matched).toBe("from-elsewhere");
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
  test("rejects blocking native regular expressions", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await firstPaneId(client);
        const search = await client.callTool({
          arguments: { pattern: "^(a+)+$", regex: true },
          name: "search_panes",
        });
        const wait = await client.callTool({
          arguments: {
            paneId,
            patterns: ["^(a+)+$"],
            regex: true,
            timeoutMs: 1_000,
          },
          name: "wait_for_text",
        });

        expect((search as { isError?: boolean }).isError).toBe(true);
        expect((wait as { isError?: boolean }).isError).toBe(true);
      });
    });
  }, 60_000);

  test("charges for the screen once, then only for what is new", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const paneId = await shellPaneId(client);

        const first = structured<{
          cursor: string;
          seeded: boolean;
          streaming: boolean;
        }>(await client.callTool({ arguments: { paneId }, name: "observe" }));
        expect(first.seeded).toBe(true);
        expect(first.streaming).toBe(true);

        await client.callTool({
          arguments: { keys: "printf 'delta-one\\n'", paneId },
          name: "send_keys",
        });
        const second = structured<{
          cursor: string;
          seeded: boolean;
          text: string;
        }>(
          await client.callTool({
            arguments: { cursor: first.cursor, paneId, waitMs: 10_000 },
            name: "observe",
          }),
        );
        expect(second.seeded).toBe(false);
        expect(cursorOffset(second.cursor)).toBeGreaterThan(cursorOffset(first.cursor));

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
        const found = structured<{
          matches: { paneId: string; text: string }[];
        }>(
          await client.callTool({
            arguments: { pattern: "needle-in-pane" },
            name: "search_panes",
          }),
        );
        expect(found.matches.map((match) => match.paneId)).toContain(paneId);
      });
    });
  }, 60_000);
});
