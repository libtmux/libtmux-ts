import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { createTmuxMcpServer } from "../src/server.js";
import { paneContentUri } from "../src/uris.js";
import { runWithCleanup } from "../../libtmux/src/_internal/test/testkit.js";
import {
  firstPaneId,
  serverFor,
  shellPaneId,
  structured,
  toolText,
  withAttendedPane,
  withClient,
  withServer,
} from "./support/server_harness.js";

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
          const me = structured<{
            callerPaneId: string;
            callerPaneIsOnThisServer: boolean;
          }>(await client.callTool({ arguments: {}, name: "whoami" }));
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
          TMUX: `${fixture.socketPath},${(await tmux.daemonIdentity()).pid},0`,
          TMUX_PANE: paneId,
        },
      );
    });
  }, 60_000);

  test("keeps caller identity separate from policy overrides", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const paneId = (await tmux.snapshot()).panes.one().id;
      const serverPid = (await tmux.daemonIdentity()).pid;
      const callerEnvironment: Record<string, string> = {
        TMUX: `${fixture.socketPath},${serverPid},0`,
        TMUX_PANE: paneId,
      };
      const options = {
        callerEnvironment,
        environment: { LIBTMUX_SAFETY: "mutating" },
      };
      const mcp = createTmuxMcpServer(tmux, options);
      callerEnvironment.TMUX = "";
      callerEnvironment.TMUX_PANE = "";
      const client = new Client({
        name: "embedded-identity",
        version: "0.0.0",
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

      await runWithCleanup(
        async () => {
          await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
          const identity = structured<{
            callerPaneId: string | null;
            callerPaneIsOnThisServer: boolean;
          }>(await client.callTool({ arguments: {}, name: "whoami" }));
          expect(identity.callerPaneId).toBe(paneId);
          expect(identity.callerPaneIsOnThisServer).toBe(true);

          const refused = await client.callTool({
            arguments: { enter: false, keys: "", paneId },
            name: "send_keys",
          });
          expect((refused as { isError?: boolean }).isError).toBe(true);
          expect(toolText(refused)).toContain("own terminal");
        },
        () => client.close(),
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
          await client.callTool({
            arguments: { name: "guard", text: "x" },
            name: "load_buffer",
          });

          // Empty text, and no killFirst: each probe proves the guard without
          // putting a character in the terminal or ending the process in it if
          // the guard is missing.
          const refusesWrite = async (
            tool: string,
            args: Record<string, unknown>,
          ): Promise<void> => {
            const refused = await client.callTool({
              arguments: args,
              name: tool,
            });
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
          TMUX: `${fixture.socketPath},${(await tmux.daemonIdentity()).pid},0`,
          TMUX_PANE: paneId,
        },
      );
    });
  }, 60_000);

  test("refuses every write path into a pane a person is watching", async () => {
    await withServer(async (fixture) => {
      await withAttendedPane(fixture, async (paneId) => {
        await withClient(fixture, async (client) => {
          await client.callTool({
            arguments: { name: "guard", text: "x" },
            name: "load_buffer",
          });

          const refusesWrite = async (
            tool: string,
            args: Record<string, unknown>,
          ): Promise<void> => {
            const refused = await client.callTool({
              arguments: args,
              name: tool,
            });
            expect((refused as { isError?: boolean }).isError).toBe(true);
            expect(toolText(refused)).toContain("person is watching");
          };

          await refusesWrite("send_keys", {
            enter: false,
            keys: "harmless",
            paneId,
          });
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

  test("force overrides the destructive guard on an attended window", async () => {
    await withServer(async (fixture) => {
      await withAttendedPane(fixture, async (paneId) => {
        await withClient(
          fixture,
          async (client) => {
            await client.callTool({ arguments: { name: "kept" }, name: "new_session" });
            const windowId = structured<{ pane: { windowId: string } }>(
              await client.callTool({ arguments: { paneId }, name: "get_pane" }),
            ).pane.windowId;

            const refused = await client.callTool({
              arguments: { windowId },
              name: "kill_window",
            });
            expect((refused as { isError?: boolean }).isError).toBe(true);
            expect(toolText(refused)).toContain("watching");

            const forced = await client.callTool({
              arguments: { force: true, windowId },
              name: "kill_window",
            });
            expect((forced as { isError?: boolean }).isError ?? false).toBe(false);
            expect(structured<{ killed: string }>(forced).killed).toBe(windowId);
            const remaining = structured<{ windows: readonly { id: string }[] }>(
              await client.callTool({ arguments: {}, name: "list_windows" }),
            ).windows;
            expect(remaining.some(({ id }) => id === windowId)).toBe(false);
          },
          { LIBTMUX_SAFETY: "destructive" },
        );
      });
    });
  }, 60_000);

  test("marks every visible split attended and only the zoomed pane", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const originalPaneId = await firstPaneId(client);
        const secondPaneId = structured<{ pane: { id: string } }>(
          await client.callTool({
            arguments: { paneId: originalPaneId, shellCommand: "exec cat" },
            name: "split_pane",
          }),
        ).pane.id;

        await withAttendedPane(fixture, async (activePaneId) => {
          const visible = structured<{ attendedPaneIds: string[] }>(
            await client.callTool({ arguments: {}, name: "whoami" }),
          ).attendedPaneIds;
          expect([...visible].sort()).toEqual([originalPaneId, secondPaneId].sort());

          await client.callTool({
            arguments: { paneId: activePaneId, zoom: true },
            name: "resize_pane",
          });
          const zoomed = structured<{ attendedPaneIds: string[] }>(
            await client.callTool({ arguments: {}, name: "whoami" }),
          ).attendedPaneIds;
          expect(zoomed).toEqual([activePaneId]);
        });
      });
    });
  }, 60_000);

  test("does not protect a same-numbered pane on another server", async () => {
    await withServer(async (callerFixture) => {
      const callerTmux = serverFor(callerFixture);
      const callerPaneId = (await callerTmux.snapshot()).panes.one().id;
      const callerPid = (await callerTmux.daemonIdentity()).pid;

      await withServer(async (targetFixture) => {
        await withClient(
          targetFixture,
          async (client) => {
            const targetPane = structured<{
              pane: { id: string; windowId: string };
            }>(
              await client.callTool({
                arguments: { paneId: callerPaneId },
                name: "get_pane",
              }),
            ).pane;
            expect(targetPane.id).toBe(callerPaneId);

            await client.callTool({
              arguments: { name: "kept", session: targetFixture.sessionName },
              name: "new_window",
            });
            const identity = structured<{ callerPaneIsOnThisServer: boolean }>(
              await client.callTool({ arguments: {}, name: "whoami" }),
            );
            expect(identity.callerPaneIsOnThisServer).toBe(false);

            const killed = await client.callTool({
              arguments: { windowId: targetPane.windowId },
              name: "kill_window",
            });
            expect((killed as { isError?: boolean }).isError ?? false).toBe(false);
          },
          {
            LIBTMUX_SAFETY: "destructive",
            TMUX: `${callerFixture.socketPath},${callerPid},0`,
            TMUX_PANE: callerPaneId,
          },
        );
      });
    });
  }, 60_000);

  test("refuses a cursor that belongs to a different stream", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const sourcePaneId = await shellPaneId(client);
        const paneId = await shellPaneId(client);
        const source = structured<{ cursor: string }>(
          await client.callTool({
            arguments: { paneId: sourcePaneId },
            name: "observe",
          }),
        );

        const ahead = await client.callTool({
          arguments: { cursor: source.cursor, paneId },
          name: "observe",
        });
        expect((ahead as { isError?: boolean }).isError).toBe(true);
        // Names the cursor it was given and the remedy, so the next call is the
        // right one rather than the same one.
        expect(toolText(ahead)).toContain(source.cursor);
        expect(toolText(ahead)).toContain("Omit cursor");

        // The same hole, where the caller's own timeout used to hide it: a
        // clean "timed_out" reported while the pane was printing.
        const waited = await client.callTool({
          arguments: {
            cursor: source.cursor,
            paneId,
            patterns: ["never-x"],
            timeoutMs: 1_000,
          },
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
        await client.callTool({
          arguments: { command: "echo one", paneId },
          name: "run_command",
        });

        const seeded = structured<{ cursor: string; seeded: boolean }>(
          await client.callTool({ arguments: { paneId }, name: "observe" }),
        );
        expect(seeded.seeded).toBe(true);

        // And the cursor it hands back is one that yields only what came after.
        await client.callTool({
          arguments: { command: "echo two", paneId },
          name: "run_command",
        });
        const delta = structured<{ text: string }>(
          await client.callTool({
            arguments: { cursor: seeded.cursor, paneId },
            name: "observe",
          }),
        );
        expect(delta.text).toContain("two");
        expect(delta.text.split("\n")).not.toContain("one");
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
          TMUX: `${fixture.socketPath},${(await tmux.daemonIdentity()).pid},0`,
          TMUX_PANE: paneId,
        },
      );
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
          await client.callTool({
            arguments: { name: "real" },
            name: "new_session",
          }),
        ).session;

        // A session whose NAME is another session's ID. tmux treats a leading
        // $ as an id lookup that fails rather than falling through to names,
        // and requireSession resolves id first — so the filters must not match
        // both namespaces at once.
        await client.callTool({
          arguments: { name: first.id },
          name: "new_session",
        });

        const panes = structured<{
          panes: { placements: { sessionId: string }[] }[];
        }>(
          await client.callTool({
            arguments: { session: first.id },
            name: "list_panes",
          }),
        ).panes;
        expect(panes.length).toBeGreaterThan(0);
        expect(
          panes.every((pane) => pane.placements.some(({ sessionId }) => sessionId === first.id)),
        ).toBe(true);

        const windows = structured<{
          windows: { placements: { sessionId: string }[] }[];
        }>(
          await client.callTool({
            arguments: { session: first.id },
            name: "list_windows",
          }),
        ).windows;
        expect(
          windows.every((window) =>
            window.placements.some(({ sessionId }) => sessionId === first.id),
          ),
        ).toBe(true);

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
});
