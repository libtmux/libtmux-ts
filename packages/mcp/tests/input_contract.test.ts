import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, test } from "bun:test";
import { link, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TestServer } from "../../libtmux/src/_internal/test/testkit.js";
import { Server } from "libtmux/server";

import { readCallerEnvironment } from "../src/caller.js";
import { isPaneInputConflict, reserveFramedCommand } from "../src/command.js";
import { createContext } from "../src/context.js";
import { resolvePolicy } from "../src/policy.js";
import { structured, withClient, withServer } from "./support/server_harness.js";

interface PanePair {
  readonly peerPaneId: string;
  readonly sourcePaneId: string;
  readonly windowId: string;
}

async function createPanePair(client: Client, name: string): Promise<PanePair> {
  const created = structured<{ paneId: string; windowId: string }>(
    await client.callTool({ arguments: { name }, name: "create_session" }),
  );
  const split = structured<{ pane: { id: string } }>(
    await client.callTool({ arguments: { paneId: created.paneId }, name: "split_window" }),
  );
  return { peerPaneId: split.pane.id, sourcePaneId: created.paneId, windowId: created.windowId };
}

async function capture(client: Client, paneId: string): Promise<string> {
  return structured<{ text: string }>(
    await client.callTool({ arguments: { paneId }, name: "capture_pane" }),
  ).text;
}

function resultText(result: unknown): string {
  const content = (result as { readonly content?: readonly { readonly text?: string }[] }).content;
  return content?.[0]?.text ?? "";
}

async function setPaneSync(fixture: TestServer, paneId: string, enabled: boolean): Promise<void> {
  await fixture.executeText([
    "set-option",
    "-p",
    "-t",
    paneId,
    "synchronize-panes",
    enabled ? "on" : "off",
  ]);
}

async function setPairSync(
  fixture: TestServer,
  pair: PanePair,
  source: boolean,
  peer: boolean,
): Promise<void> {
  await setPaneSync(fixture, pair.sourcePaneId, source);
  await setPaneSync(fixture, pair.peerPaneId, peer);
}

async function waitForPaneFormat(
  fixture: TestServer,
  paneId: string,
  format: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- state changes asynchronously in tmux.
    const value = await fixture.executeText(["display-message", "-p", "-t", paneId, format]);
    if (value.stdout[0] === expected) return;
    // eslint-disable-next-line no-await-in-loop -- each poll follows the previous observation.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${paneId} did not reach ${format}=${expected}`);
}

test("live socket aliases share caller and pane ownership", async () => {
  await withServer(async (fixture) => {
    const symbolic = join(dirname(fixture.socketPath), "mcp-symlink.sock");
    const hardlink = join(dirname(fixture.socketPath), "mcp-hardlink.sock");
    const contexts: ReturnType<typeof createContext>[] = [];
    try {
      await symlink(fixture.socketPath, symbolic);
      await link(fixture.socketPath, hardlink);
      const routes = [fixture.socketPath, symbolic, hardlink];
      for (const socketPath of routes) {
        contexts.push(
          createContext(
            new Server({
              environment: fixture.controllerEnvironment,
              socketPath,
              tmuxBin: fixture.tmuxExecutable,
            }),
            resolvePolicy({}),
          ),
        );
      }
      const observations = await Promise.all(contexts.map((context) => context.observeInput()));
      const first = observations[0];
      if (first === undefined) throw new Error("fixture produced no input observation");
      const physical = [
        first.authority.endpointDevice,
        first.authority.endpointInode,
        first.authority.pid,
        first.authority.startTime,
      ];
      expect(
        observations.map(({ authority }) => [
          authority.endpointDevice,
          authority.endpointInode,
          authority.pid,
          authority.startTime,
        ]),
      ).toEqual(Array.from({ length: routes.length }, () => physical));

      const pane = first.snapshot.panes.toArray()[0];
      const sessionIndex = pane?.format.session_id?.slice(1);
      if (pane === undefined || sessionIndex === undefined) throw new Error("fixture has no pane");
      const held = reserveFramedCommand(first.authority, pane.id, "live alias");
      if (isPaneInputConflict(held)) throw new Error("initial reservation conflicted");
      try {
        for (const observed of observations.slice(1)) {
          const conflict = reserveFramedCommand(observed.authority, pane.id, "alias writer");
          expect(isPaneInputConflict(conflict)).toBe(true);
          if (!isPaneInputConflict(conflict)) conflict.release();
        }
      } finally {
        held.release();
      }

      await Promise.all(
        [symbolic, hardlink].map(async (socketPath) => {
          const callerContext = createContext(
            new Server({
              environment: fixture.controllerEnvironment,
              socketPath: fixture.socketPath,
              tmuxBin: fixture.tmuxExecutable,
            }),
            resolvePolicy({}),
            readCallerEnvironment({
              TMUX: `${socketPath},${fixture.daemonIdentity.pid},${sessionIndex}`,
              TMUX_PANE: pane.id,
            }),
          );
          contexts.push(callerContext);
          const caller = await callerContext.observeInput();
          expect(caller.identity.inputProblem, socketPath).toBeUndefined();
          expect(caller.identity.callerPaneIsOnThisServer, socketPath).toBe(true);
        }),
      );
    } finally {
      await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
      await unlink(symbolic).catch(() => undefined);
      await unlink(hardlink).catch(() => undefined);
    }
  });
}, 15_000);

test("paste_text keeps its Enter and payload target-only", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const pair = await createPanePair(client, "paste-target");
      await client.callTool({
        arguments: { enabled: true, windowId: pair.windowId },
        name: "set_synchronize_panes",
      });

      const marker = "LTX_PASTE_TARGET_ONLY_42";
      const pasted = await client.callTool({
        arguments: {
          enter: true,
          paneId: pair.sourcePaneId,
          text: `printf '${marker}\\n'`,
        },
        name: "paste_text",
      });
      expect(pasted.isError, JSON.stringify(pasted.content)).not.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await capture(client, pair.sourcePaneId)).toContain(marker);
      expect(await capture(client, pair.peerPaneId)).not.toContain(marker);

      const buffers = await fixture.executeText(["list-buffers", "-F", "#{buffer_name}"]);
      expect(buffers.stdout.filter((name) => name.startsWith("ltx-mcp-paste-"))).toEqual([]);
    });
  });
}, 15_000);

test("pane-scoped synchronization keeps input cohorts exact", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    await withClient(fixture, async (client) => {
      const pair = await createPanePair(client, "cohort");

      await setPairSync(fixture, pair, false, true);
      const sendMarker = "LTX_SOURCE_OFF_PEER_ON";
      const sent = structured<{ resolvedPaneIds: readonly string[] }>(
        await client.callTool({
          arguments: {
            keys: `printf '${sendMarker}\\n'`,
            literal: true,
            paneId: pair.sourcePaneId,
          },
          name: "send_keys",
        }),
      );
      expect(sent.resolvedPaneIds).toEqual([pair.sourcePaneId]);

      const runMarker = "LTX_RUN_SOURCE_OFF_PEER_ON";
      const run = structured<{ outcome: string; output: string }>(
        await client.callTool({
          arguments: { command: `printf '${runMarker}\\n'`, paneId: pair.sourcePaneId },
          name: "run_shell_command",
        }),
      );
      expect(run).toMatchObject({ outcome: "completed", output: runMarker });

      await setPairSync(fixture, pair, true, false);
      const batchMarker = "LTX_SOURCE_ON_PEER_OFF";
      const batch = structured<{
        completed: number;
        targets: readonly { resolvedPaneIds: readonly string[] }[];
      }>(
        await client.callTool({
          arguments: {
            operations: [
              {
                keys: `printf '${batchMarker}\\n'`,
                literal: true,
                paneId: pair.sourcePaneId,
              },
            ],
          },
          name: "send_keys_batch",
        }),
      );
      expect(batch).toMatchObject({
        completed: 1,
        targets: [{ resolvedPaneIds: [pair.sourcePaneId] }],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await capture(client, pair.sourcePaneId)).toContain(batchMarker);
      const peer = await capture(client, pair.peerPaneId);
      expect(peer).not.toContain(sendMarker);
      expect(peer).not.toContain(runMarker);
      expect(peer).not.toContain(batchMarker);
    });
  });
}, 15_000);

test("a modal, dead, or caller cohort peer blocks input", async () => {
  await withServer(async (fixture) => {
    await fixture.executeText(["set-option", "-g", "default-command", "sh"]);
    let pair: PanePair | undefined;
    await withClient(fixture, async (client) => {
      pair = await createPanePair(client, "guarded-cohort");
      await setPairSync(fixture, pair, true, true);

      await fixture.executeText(["copy-mode", "-t", pair.peerPaneId]);
      await waitForPaneFormat(fixture, pair.peerPaneId, "#{pane_in_mode}", "1");
      const modalMarker = "LTX_MODAL_PEER_REFUSED";
      const modal = await client.callTool({
        arguments: {
          keys: `printf '${modalMarker}\\n'`,
          literal: true,
          paneId: pair.sourcePaneId,
        },
        name: "send_keys",
      });
      expect(modal.isError).toBe(true);
      expect(resultText(modal)).toContain(pair.peerPaneId);
      expect(resultText(modal)).toContain("human-owned mode");
      expect(await capture(client, pair.sourcePaneId)).not.toContain(modalMarker);
      await fixture.executeText(["send-keys", "-X", "-t", pair.peerPaneId, "cancel"]);
      await waitForPaneFormat(fixture, pair.peerPaneId, "#{pane_in_mode}", "0");

      await setPairSync(fixture, pair, false, false);
      await fixture.executeText([
        "set-option",
        "-p",
        "-t",
        pair.peerPaneId,
        "remain-on-exit",
        "on",
      ]);
      await fixture.executeText(["send-keys", "-t", pair.peerPaneId, "exit", "Enter"]);
      await waitForPaneFormat(fixture, pair.peerPaneId, "#{pane_dead}", "1");
      await setPairSync(fixture, pair, true, true);
      const deadMarker = "LTX_DEAD_PEER_REFUSED";
      const dead = structured<{ completed: number; failures: readonly { reason: string }[] }>(
        await client.callTool({
          arguments: {
            operations: [{ keys: deadMarker, literal: true, paneId: pair.sourcePaneId }],
          },
          name: "send_keys_batch",
        }),
      );
      expect(dead.completed).toBe(0);
      expect(dead.failures[0]?.reason).toContain(pair.peerPaneId);
      expect(dead.failures[0]?.reason).toContain("dead");
      expect(await capture(client, pair.sourcePaneId)).not.toContain(deadMarker);
      await fixture.executeText(["respawn-pane", "-k", "-t", pair.peerPaneId]);
      await waitForPaneFormat(fixture, pair.peerPaneId, "#{pane_dead}", "0");

      await setPairSync(fixture, pair, false, false);
      const running = structured<{ outcome: string; stillRunning: boolean }>(
        await client.callTool({
          arguments: { command: "sleep 2", paneId: pair.peerPaneId, timeoutMs: 500 },
          name: "run_shell_command",
        }),
      );
      expect(running).toMatchObject({ outcome: "timed_out", stillRunning: true });
      await setPairSync(fixture, pair, true, true);
      const active = await client.callTool({
        arguments: { enter: false, keys: "x", paneId: pair.sourcePaneId },
        name: "send_keys",
      });
      expect(active.isError).toBe(true);
      expect(resultText(active)).toContain(pair.peerPaneId);
      expect(resultText(active)).toContain("run_shell_command");
      await setPairSync(fixture, pair, false, false);
      await waitForPaneFormat(fixture, pair.peerPaneId, "#{pane_current_command}", "sh");
      await setPairSync(fixture, pair, true, true);
    });

    if (pair === undefined) throw new Error("pane pair was not created");
    const guardedPair = pair;
    const callerSession = await fixture.executeText([
      "display-message",
      "-p",
      "-t",
      guardedPair.peerPaneId,
      "#{session_id}",
    ]);
    const callerSessionId = callerSession.stdout[0];
    if (callerSessionId === undefined || !/^\$[0-9]+$/u.test(callerSessionId)) {
      throw new Error("caller pane has no canonical session id");
    }

    await withClient(
      fixture,
      async (client) => {
        const callerMarker = "LTX_CALLER_PEER_REFUSED";
        const caller = await client.callTool({
          arguments: {
            command: `printf '${callerMarker}\\n'`,
            paneId: guardedPair.sourcePaneId,
          },
          name: "run_shell_command",
        });
        expect(caller.isError).toBe(true);
        expect(resultText(caller)).toContain(guardedPair.peerPaneId);
        expect(resultText(caller)).toContain("pane this MCP server runs in");
        expect(await capture(client, guardedPair.sourcePaneId)).not.toContain(callerMarker);
      },
      {
        TMUX: `${fixture.socketPath},${fixture.daemonIdentity.pid},${callerSessionId.slice(1)}`,
        TMUX_PANE: guardedPair.peerPaneId,
      },
    );
  });
}, 20_000);
