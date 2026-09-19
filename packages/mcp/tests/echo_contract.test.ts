/**
 * Real-tmux coverage of the echo contract: `wait_for_text` must never treat
 * this server's own typing as pane output, and must never let masking that
 * typing hide real output either. Scenarios S1-S4 and S6 below; S5 (a cold
 * shell that has not drawn its first prompt) already has the reference
 * fixture in `server_contract.test.ts` and is not duplicated here. The
 * classifier and word-boundary logic these scenarios exercise end to end have
 * their own fast, tmux-free coverage in `pane_echo.test.ts`.
 */
import { expect, test } from "bun:test";

import { structured, withClient, withServer } from "./support/server_harness.js";
import type { TestServer } from "../../libtmux/src/_internal/test/testkit.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface Created {
  readonly paneId: string;
}

interface Waited {
  readonly alreadyOnScreen: boolean;
  readonly matched: string | null;
  readonly outcome: string;
  readonly output: string;
}

async function shSession(client: Client, name: string): Promise<string> {
  const created = structured<Created>(
    await client.callTool({ arguments: { height: 24, name, width: 80 }, name: "create_session" }),
  );
  return created.paneId;
}

async function paneTty(fixture: TestServer, paneId: string): Promise<string> {
  const result = await fixture.executeText(["display-message", "-p", "-t", paneId, "#{pane_tty}"]);
  const tty = result.stdout[0];
  if (tty === undefined || tty === "") throw new Error(`pane ${paneId} reported no tty`);
  return tty;
}

/** Write `line` directly onto `paneId`'s tty from `writerPaneId`, after `delaySeconds`. */
async function injectForeignOutput(
  client: Client,
  fixture: TestServer,
  writerPaneId: string,
  targetPaneId: string,
  line: string,
  delaySeconds: number,
): Promise<void> {
  const tty = await paneTty(fixture, targetPaneId);
  const answer = await client.callTool({
    arguments: {
      command: `sleep ${String(delaySeconds)} && printf '%s\\n' '${line}' > ${tty}`,
      paneId: writerPaneId,
    },
    name: "run_shell_command",
  });
  expect(answer.isError, JSON.stringify(answer)).not.toBe(true);
}

test("S1: a short unsubmitted answer does not mask a longer real output line", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const paneId = await shSession(client, "s1");
      const split = structured<{ pane: { id: string } }>(
        await client.callTool({ arguments: { paneId }, name: "split_window" }),
      );
      const writerPaneId = split.pane.id;

      // Type "y" with no Enter: a short answer that is also the last letter
      // of the real output "ready" below.
      await client.callTool({
        arguments: { enter: false, keys: "y", literal: true, paneId },
        name: "send_keys",
      });

      const waitPromise = client.callTool({
        arguments: { paneId, patterns: ["ready"], timeoutMs: 3_000 },
        name: "wait_for_text",
      });
      await injectForeignOutput(client, fixture, writerPaneId, paneId, "ready", 0.3);
      const waited = structured<Waited>(await waitPromise);

      expect(waited.outcome).toBe("matched");
      expect(waited.matched).toBe("ready");
    });
  });
}, 20_000);

async function runS2(
  client: Client,
  paneId: string,
  waitFirst: boolean,
): Promise<{ readonly elapsedMs: number; readonly marker: string; readonly waited: Waited }> {
  const marker = `S2MARKER${String(Date.now())}${waitFirst ? "A" : "B"}`;
  const send = (): ReturnType<Client["callTool"]> =>
    client.callTool({
      arguments: { enter: true, keys: `sleep 1; echo ${marker}`, literal: true, paneId },
      name: "send_keys",
    });
  const wait = (): ReturnType<Client["callTool"]> =>
    client.callTool({
      arguments: { paneId, patterns: [marker], timeoutMs: 4_000 },
      name: "wait_for_text",
    });

  let waitPromise: ReturnType<Client["callTool"]>;
  let start: number;
  if (waitFirst) {
    start = Date.now();
    waitPromise = wait();
    await send();
  } else {
    await send();
    start = Date.now();
    waitPromise = wait();
  }
  const waited = structured<Waited>(await waitPromise);
  return { elapsedMs: Date.now() - start, marker, waited };
}

for (const waitFirst of [true, false]) {
  test(`S2: a submitted command's echo is not the match (wait started ${waitFirst ? "before" : "after"} the send)`, async () => {
    await withServer(async (fixture) => {
      await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
      await withClient(fixture, async (client) => {
        const paneId = await shSession(client, "s2");
        const { elapsedMs, marker, waited } = await runS2(client, paneId, waitFirst);

        expect(waited.outcome).toBe("matched");
        expect(waited.matched).toBe(marker);
        const lines = waited.output.trim().split("\n");
        const outputIndex = lines.indexOf(marker);
        expect(outputIndex).toBeGreaterThanOrEqual(0);
        // A wait started before the send sees the command's own echo in its
        // stream too; the real output row must come strictly after it in the
        // captured order — a content check, not a timing one, so it holds up
        // under parallel-test scheduling jitter that a wall-clock assertion
        // would not. A wait started after the send never sees that echo at
        // all (it printed before the wait subscribed), so timing is the only
        // available discriminator there: the real output is gated behind the
        // pane's own `sleep 1`, which an instant match on a buffered echo
        // could not be.
        const echoIndex = lines.indexOf(`sleep 1; echo ${marker}`);
        if (waitFirst) {
          expect(echoIndex).toBeGreaterThanOrEqual(0);
          expect(outputIndex).toBeGreaterThan(echoIndex);
        } else {
          expect(echoIndex).toBe(-1);
          expect(elapsedMs).toBeGreaterThanOrEqual(700);
        }
      });
    });
  }, 15_000);
}

test("S3: unsubmitted text times out rather than matching its own echo", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const paneId = await shSession(client, "s3");
      const waitPromise = client.callTool({
        arguments: { paneId, patterns: ["MARKER"], timeoutMs: 1_000 },
        name: "wait_for_text",
      });
      await client.callTool({
        arguments: { enter: false, keys: "echo MARKER", literal: true, paneId },
        name: "send_keys",
      });
      const waited = structured<Waited>(await waitPromise);

      expect(waited.outcome).toBe("timed_out");
      expect(waited.matched).toBeNull();
    });
  });
}, 10_000);

test("S4: edits are applied before a line is submitted, and key names never join the tracked text", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const paneId = await shSession(client, "s4");
      const waitPromise = client.callTool({
        arguments: { paneId, patterns: ["MARKER"], timeoutMs: 4_000 },
        name: "wait_for_text",
      });

      await client.callTool({
        arguments: { enter: false, keys: "xMARKER", literal: true, paneId },
        name: "send_keys",
      });
      for (let i = 0; i < 7; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- each backspace is its own call, as the scenario requires.
        await client.callTool({
          arguments: { enter: false, keys: "BSpace", literal: false, paneId },
          name: "send_keys",
        });
      }
      await client.callTool({
        arguments: { enter: true, keys: "echo MARKER", literal: true, paneId },
        name: "send_keys",
      });

      const waited = structured<Waited>(await waitPromise);
      expect(waited.outcome).toBe("matched");
      expect(waited.matched).toBe("MARKER");
      // The match is the real output row, not the leftover "xMARKER" typing
      // or the submitted command's own echo: the captured stream must have
      // run all the way through both before reaching the real line.
      const lines = waited.output.trim().split("\n");
      const echoIndex = lines.indexOf("echo MARKER");
      const outputIndex = lines.indexOf("MARKER");
      expect(echoIndex).toBeGreaterThanOrEqual(0);
      expect(outputIndex).toBeGreaterThan(echoIndex);
    });
  });
}, 15_000);

test("S6: an unmodelled key stops discounting the pane's current line", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const paneId = await shSession(client, "s6");
      const split = structured<{ pane: { id: string } }>(
        await client.callTool({ arguments: { paneId }, name: "split_window" }),
      );
      const writerPaneId = split.pane.id;

      await client.callTool({
        arguments: { enter: false, keys: "xMARKER", literal: true, paneId },
        name: "send_keys",
      });
      // Left is a key send_keys cannot apply to the tracked line at all.
      await client.callTool({
        arguments: { enter: false, keys: "Left", literal: false, paneId },
        name: "send_keys",
      });

      const waitPromise = client.callTool({
        arguments: { paneId, patterns: ["xMARKER"], timeoutMs: 3_000 },
        name: "wait_for_text",
      });
      await injectForeignOutput(client, fixture, writerPaneId, paneId, "xMARKER", 0.3);
      const waited = structured<Waited>(await waitPromise);

      // The abandoned typing must not still be masking a later, genuine line
      // that happens to repeat it.
      expect(waited.outcome).toBe("matched");
      expect(waited.matched).toBe("xMARKER");
    });
  });
}, 20_000);
