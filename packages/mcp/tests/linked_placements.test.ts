import { join } from "node:path";
import { rm } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { createTmuxMcpServer } from "../src/server.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../libtmux/src/_internal/test/run_root.js";
import { TestServer } from "../../libtmux/src/_internal/test/test_server.js";
import {
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../libtmux/src/_internal/test/temp_root.js";

interface Placement {
  readonly index: number;
  readonly sessionId: string;
  readonly sessionName: string;
}

interface PaneView {
  readonly id: string;
  readonly placements: readonly Placement[];
  readonly windowId: string;
}

interface WindowView {
  readonly id: string;
  readonly placements: readonly (Placement & { readonly active: boolean })[];
}

interface SharedTopology {
  readonly groupedSessionId: string;
  readonly originIndex: number;
  readonly originSessionId: string;
  readonly otherPaneId: string;
  readonly otherSessionId: string;
  readonly otherWindowId: string;
  readonly sharedPaneId: string;
  readonly sharedWindowId: string;
}

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-mcp-place-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "placement" });
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

async function withClient(
  fixture: TestServer,
  body: (client: Client) => Promise<void>,
  options: { readonly live?: boolean } = {},
): Promise<void> {
  const mcp = createTmuxMcpServer(serverFor(fixture), {
    environment: {
      LIBTMUX_MCP_LIVE: options.live === true ? "1" : "0",
      LIBTMUX_SAFETY: "destructive",
      TMUX: "",
      TMUX_PANE: "",
    },
  });
  const client = new Client({ name: "linked-placement-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  await runWithCleanup(
    () => body(client),
    () => client.close(),
  );
}

function structured<T>(result: unknown): T {
  return (result as { readonly structuredContent: T }).structuredContent;
}

function toolText(result: unknown): string {
  const content = (result as { readonly content: readonly { readonly text?: string }[] }).content;
  return content.map((entry) => entry.text ?? "").join("\n");
}

function placementKeys(placements: readonly Placement[]): readonly string[] {
  return placements.map(({ index, sessionId }) => `${sessionId}:${String(index)}`);
}

async function makeSharedTopology(fixture: TestServer): Promise<SharedTopology> {
  const tmux = serverFor(fixture);
  const initial = await tmux.snapshot();
  const origin = initial.sessions.one({ name: fixture.sessionName });
  const shared = origin.windows.one();
  const firstPane = shared.panes.one();
  const secondPane = await firstPane.split({ shellCommand: "sh" });
  const other = await tmux.newSession({ name: "other", windowName: "other-only" });
  const otherWindow = (await tmux.snapshot()).windows.one({
    session: { is: { id: other.id } },
  });
  const otherPane = otherWindow.panes.one();

  await shared.link({ index: 11, session: origin.id });
  await shared.link({ index: 9, session: other.id });
  const grouped = await tmux.newSession({ groupWith: origin.id, name: "grouped" });

  return {
    groupedSessionId: grouped.id,
    originIndex: shared.index ?? 0,
    originSessionId: origin.id,
    otherPaneId: otherPane.id,
    otherSessionId: other.id,
    otherWindowId: otherWindow.id,
    sharedPaneId: secondPane.id,
    sharedWindowId: shared.id,
  };
}

function expectedSharedPlacements(topology: SharedTopology): readonly string[] {
  return [
    `${topology.originSessionId}:${String(topology.originIndex)}`,
    `${topology.originSessionId}:11`,
    `${topology.otherSessionId}:9`,
    `${topology.groupedSessionId}:${String(topology.originIndex)}`,
    `${topology.groupedSessionId}:11`,
  ].toSorted((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

describe("linked and grouped placements", () => {
  test("rebinds a pane subscription after its placement is unlinked", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const initial = await tmux.snapshot();
      const origin = initial.sessions.one({ name: fixture.sessionName });
      const shared = origin.windows.one();
      const paneId = shared.panes.one().id;
      // MCP has no link/unlink tool, so the fixture creates the placement directly.
      await origin.newWindow({ name: "origin-keeper" });
      const survivor = await tmux.newSession({ name: "survivor", windowName: "survivor-keeper" });
      await shared.link({ index: 9, session: survivor.id });

      await withClient(
        fixture,
        async (client) => {
          const uri = `tmux://panes/${encodeURIComponent(paneId)}/content`;
          const updates: string[] = [];
          client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
            updates.push(notification.params.uri);
          });
          await client.subscribeResource({ uri });

          const controls = async (): Promise<string[]> =>
            (
              await fixture.executeText([
                "list-clients",
                "-F",
                "#{session_id}\t#{client_control_mode}",
              ])
            ).stdout
              .filter((line) => line.endsWith("\t1"))
              .map((line) => line.slice(0, line.indexOf("\t")));
          const initialControls = await controls();
          expect(initialControls).toHaveLength(1);
          const [boundSessionId] = initialControls;
          if (boundSessionId === undefined) throw new Error("No subscription control client");
          const placements = (await tmux.snapshot()).panes
            .toArray()
            .filter((pane) => pane.id === paneId);
          const bound = placements.find((pane) => pane.format.session_id === boundSessionId);
          const surviving = placements.find((pane) => pane.format.session_id !== boundSessionId);
          if (bound === undefined || surviving === undefined) {
            throw new Error("Expected bound and surviving pane placements");
          }
          const boundIndex = bound.window?.index ?? Number(bound.format.window_index);
          await fixture.executeText([
            "unlink-window",
            "-t",
            `${boundSessionId}:${String(boundIndex)}`,
          ]);

          const deadline = Date.now() + 20_000;
          let controlSessions = await controls();
          while (!controlSessions.includes(surviving.format.session_id) && Date.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop -- each read waits for the rebind it observes.
            await new Promise((resolve) => setTimeout(resolve, 50));
            // eslint-disable-next-line no-await-in-loop -- each query observes the preceding delay.
            controlSessions = await controls();
          }
          expect(controlSessions).toContain(surviving.format.session_id);

          const handoffDeadline = Date.now() + 20_000;
          while (updates.length === 0 && Date.now() < handoffDeadline) {
            // eslint-disable-next-line no-await-in-loop -- the handoff notice is the ready barrier.
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(updates).toContain(uri);
          updates.length = 0;
          await fixture.executeText(["send-keys", "-t", paneId, "-l", "printf 'after-rebind\\n'"]);
          await fixture.executeText(["send-keys", "-t", paneId, "Enter"]);
          const outputDeadline = Date.now() + 20_000;
          while (updates.length === 0 && Date.now() < outputDeadline) {
            // eslint-disable-next-line no-await-in-loop -- each read waits for the output notice.
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(updates).toContain(uri);
          await client.unsubscribeResource({ uri });
        },
        { live: true },
      );
    });
  }, 60_000);

  test("publishes one truthful entity for each shared id", async () => {
    await withServer(async (fixture) => {
      const topology = await makeSharedTopology(fixture);
      await withClient(fixture, async (client) => {
        const windows = structured<{ readonly windows: readonly WindowView[] }>(
          await client.callTool({ arguments: {}, name: "list_windows" }),
        ).windows;
        const panes = structured<{ readonly panes: readonly PaneView[] }>(
          await client.callTool({ arguments: {}, name: "list_panes" }),
        ).panes;
        const sharedWindow = windows.find(({ id }) => id === topology.sharedWindowId);
        const sharedPane = panes.find(({ id }) => id === topology.sharedPaneId);

        expect(windows).toHaveLength(2);
        expect(panes).toHaveLength(3);
        expect(sharedWindow).toBeDefined();
        expect(sharedPane).toBeDefined();
        expect(placementKeys(sharedWindow?.placements ?? [])).toEqual(
          expectedSharedPlacements(topology),
        );
        expect(placementKeys(sharedPane?.placements ?? [])).toEqual(
          expectedSharedPlacements(topology),
        );
        expect(sharedWindow).not.toHaveProperty("sessionId");
        expect(sharedWindow).not.toHaveProperty("sessionName");
        expect(sharedWindow).not.toHaveProperty("index");
        expect(sharedWindow).not.toHaveProperty("active");
        expect(sharedPane).not.toHaveProperty("sessionId");
        expect(sharedPane).not.toHaveProperty("sessionName");

        const info = structured<{ panes: number; sessions: number; windows: number }>(
          await client.callTool({ arguments: {}, name: "server_info" }),
        );
        expect(info).toMatchObject({ panes: 3, sessions: 3, windows: 2 });

        const resources = (await client.listResources()).resources;
        const uris = resources.map(({ uri }) => uri);
        expect(new Set(uris).size).toBe(uris.length);
        expect(uris.filter((uri) => /^tmux:\/\/windows\/%40\d+$/u.test(uri))).toHaveLength(2);
        expect(uris.filter((uri) => /^tmux:\/\/panes\/%25\d+$/u.test(uri))).toHaveLength(3);
        expect(
          resources.find(
            ({ uri }) => uri === `tmux://panes/${encodeURIComponent(topology.sharedPaneId)}`,
          )?.description,
        ).toBe("One pane.");

        for (const ref of [
          { type: "ref/resource" as const, uri: "tmux://panes/{paneId}" },
          { name: "run-and-check", type: "ref/prompt" as const },
        ]) {
          // eslint-disable-next-line no-await-in-loop -- each protocol surface must deduplicate.
          const completion = await client.complete({
            argument: { name: "paneId", value: "%" },
            ref,
          });
          expect(
            completion.completion.values.filter((value) => value === topology.sharedPaneId),
          ).toHaveLength(1);
        }

        for (const call of [
          { arguments: { paneId: topology.sharedPaneId }, name: "get_pane" },
          {
            arguments: { paneId: topology.sharedPaneId, title: "shared" },
            name: "set_pane_title",
          },
          {
            arguments: { name: "shared-renamed", windowId: topology.sharedWindowId },
            name: "rename_window",
          },
          {
            arguments: { layout: "tiled", windowId: topology.sharedWindowId },
            name: "select_layout",
          },
        ]) {
          // eslint-disable-next-line no-await-in-loop -- each call checks the state left by the last.
          const result = await client.callTool(call);
          expect(result.isError ?? false, `${call.name}: ${toolText(result)}`).toBe(false);
        }

        for (const uri of [
          `tmux://windows/${encodeURIComponent(topology.sharedWindowId)}`,
          `tmux://panes/${encodeURIComponent(topology.sharedPaneId)}`,
        ]) {
          // eslint-disable-next-line no-await-in-loop -- each resource read is an independent assertion.
          const read = await client.readResource({ uri });
          expect(read.contents).toHaveLength(1);
          const content = read.contents[0];
          if (content === undefined || !("text" in content)) throw new Error(`No text for ${uri}`);
          expect(
            placementKeys((JSON.parse(content.text) as WindowView | PaneView).placements),
          ).toEqual(expectedSharedPlacements(topology));
        }
      });
    });
  }, 60_000);

  test("refuses an ambiguous source and lists every placement", async () => {
    await withServer(async (fixture) => {
      const topology = await makeSharedTopology(fixture);
      await withClient(fixture, async (client) => {
        const calls = [
          { arguments: { windowId: topology.sharedWindowId }, name: "select_window" },
          { arguments: { index: 7, windowId: topology.sharedWindowId }, name: "move_window" },
          {
            arguments: {
              otherWindowId: topology.otherWindowId,
              windowId: topology.sharedWindowId,
            },
            name: "swap_window",
          },
          {
            arguments: { paneId: topology.sharedPaneId, windowName: "extracted" },
            name: "move_pane",
          },
        ];

        for (const call of calls) {
          // eslint-disable-next-line no-await-in-loop -- each refusal reads the same topology.
          const result = await client.callTool(call);
          expect(result.isError, call.name).toBe(true);
          const text = toolText(result);
          for (const choice of expectedSharedPlacements(topology)) {
            expect(text, `${call.name} omitted ${choice}`).toContain(choice);
          }
        }

        const partial = await client.callTool({
          arguments: {
            sourceSession: topology.originSessionId,
            windowId: topology.sharedWindowId,
          },
          name: "select_window",
        });
        expect(partial.isError).toBe(true);
        expect(toolText(partial)).toContain(`${topology.originSessionId}:11`);
        expect(toolText(partial)).toContain(
          `${topology.originSessionId}:${String(topology.originIndex)}`,
        );

        const indexOnly = await client.callTool({
          arguments: { sourceIndex: 9, windowId: topology.sharedWindowId },
          name: "select_window",
        });
        expect(indexOnly.isError).toBe(true);
        for (const choice of expectedSharedPlacements(topology)) {
          expect(toolText(indexOnly), `sourceIndex-only refusal omitted ${choice}`).toContain(
            choice,
          );
        }
      });
    });
  }, 60_000);

  test("searches a linked pane once and returns every placement", async () => {
    await withServer(async (fixture) => {
      const topology = await makeSharedTopology(fixture);
      await withClient(fixture, async (client) => {
        const written = await client.callTool({
          arguments: { command: "printf 'linked-search-needle\\n'", paneId: topology.sharedPaneId },
          name: "run_command",
        });
        expect(written.isError ?? false, toolText(written)).toBe(false);

        const search = structured<{
          readonly matches: readonly {
            readonly paneId: string;
            readonly placements: readonly Placement[];
          }[];
          readonly panesSearched: number;
        }>(
          await client.callTool({
            arguments: { pattern: "linked-search-needle" },
            name: "search_panes",
          }),
        );
        const matches = search.matches.filter(({ paneId }) => paneId === topology.sharedPaneId);

        expect(search.panesSearched).toBe(3);
        expect(matches.length).toBeGreaterThan(0);
        for (const match of matches) {
          expect(placementKeys(match.placements)).toEqual(expectedSharedPlacements(topology));
          expect(match).not.toHaveProperty("sessionName");
        }
      });
    });
  }, 60_000);

  test("honors explicit sources for select, move, swap, and break", async () => {
    await withServer(async (fixture) => {
      const topology = await makeSharedTopology(fixture);
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        const selected = await client.callTool({
          arguments: {
            sourceIndex: 11,
            sourceSession: topology.originSessionId,
            windowId: topology.sharedWindowId,
          },
          name: "select_window",
        });
        expect(selected.isError ?? false, toolText(selected)).toBe(false);
        expect(
          Number(
            (await tmux.snapshot()).sessions.one({ id: topology.originSessionId }).activeWindow
              ?.index,
          ),
        ).toBe(11);

        const moved = await client.callTool({
          arguments: {
            index: 7,
            sourceIndex: 11,
            sourceSession: topology.originSessionId,
            windowId: topology.sharedWindowId,
          },
          name: "move_window",
        });
        expect(moved.isError ?? false, toolText(moved)).toBe(false);
        let snapshot = await tmux.snapshot();
        expect(
          snapshot.windows.exists({
            id: topology.sharedWindowId,
            index: "7",
            session: { is: { id: topology.originSessionId } },
          }),
        ).toBe(true);
        expect(
          snapshot.windows.exists({
            id: topology.sharedWindowId,
            index: "11",
            session: { is: { id: topology.originSessionId } },
          }),
        ).toBe(false);

        const swapped = await client.callTool({
          arguments: {
            otherSourceIndex: 0,
            otherSourceSession: topology.otherSessionId,
            otherWindowId: topology.otherWindowId,
            sourceIndex: 7,
            sourceSession: topology.originSessionId,
            windowId: topology.sharedWindowId,
          },
          name: "swap_window",
        });
        expect(swapped.isError ?? false, toolText(swapped)).toBe(false);
        snapshot = await tmux.snapshot();
        expect(
          snapshot.windows.exists({
            id: topology.sharedWindowId,
            index: "0",
            session: { is: { id: topology.otherSessionId } },
          }),
        ).toBe(true);
        expect(
          snapshot.windows.exists({
            id: topology.otherWindowId,
            index: "7",
            session: { is: { id: topology.originSessionId } },
          }),
        ).toBe(true);

        const broken = await client.callTool({
          arguments: {
            paneId: topology.sharedPaneId,
            sourceIndex: 0,
            sourceSession: topology.otherSessionId,
            windowName: "extracted",
          },
          name: "move_pane",
        });
        expect(broken.isError ?? false, toolText(broken)).toBe(false);
        expect(
          placementKeys(structured<{ pane: PaneView }>(broken).pane.placements).every((choice) =>
            choice.startsWith(`${topology.otherSessionId}:`),
          ),
        ).toBe(true);
      });
    });
  }, 60_000);

  test("keeps grouped entities alive through the remaining session", async () => {
    await withServer(async (fixture) => {
      const topology = await makeSharedTopology(fixture);
      const tmux = serverFor(fixture);
      await withClient(fixture, async (client) => {
        const killed = await client.callTool({
          arguments: { session: topology.groupedSessionId },
          name: "kill_session",
        });
        expect(killed.isError ?? false, toolText(killed)).toBe(false);
        expect(toolText(killed)).toContain("shared with other sessions remain");

        const after = await tmux.snapshot();
        expect(after.sessions.exists({ id: topology.groupedSessionId })).toBe(false);
        expect(after.windows.exists({ id: topology.sharedWindowId })).toBe(true);
        expect(after.panes.exists({ id: topology.sharedPaneId })).toBe(true);
      });
    });
  }, 60_000);

  test("checks a timed-out command through duplicate pane placements", async () => {
    await withServer(async (fixture) => {
      const topology = await makeSharedTopology(fixture);
      await withClient(fixture, async (client) => {
        const answer = await client.callTool({
          arguments: { command: "sleep 2", paneId: topology.sharedPaneId, timeoutMs: 1_000 },
          name: "run_command",
        });

        expect(answer.isError ?? false, toolText(answer)).toBe(false);
        expect(structured<{ outcome: string }>(answer).outcome).toBe("timed_out");
      });
    });
  }, 60_000);
});
