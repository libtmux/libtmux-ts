import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import { LiveHub } from "../src/live.js";
import { sessionUri } from "../src/uris.js";
import {
  controlSessionIds,
  makeTestDirectory,
  serverFor,
  shellPaneId,
  shellQuote,
  structured,
  toolText,
  waitUntil,
  withClient,
  withServer,
} from "./support/server_harness.js";

describe("staying out of the way", () => {
  test("lets go of a session's connection once nothing is reading it", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      const controlClients = async (): Promise<number> =>
        (
          await tmux.cmd("list-clients", ["-F", "#{client_control_mode}"], {
            target: null,
          })
        ).filter((line) => line === "1").length;

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
          await tmux.cmd("list-clients", ["-F", "#{client_control_mode}"], {
            target: null,
          })
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
        await waitUntil(
          async () => (await controlSessionIds(fixture)).includes(fixture.sessionId),
          "topology listener did not attach to the fixture session",
        );
        notices = 0;

        // Not through this server. A person in a terminal, or another agent on
        // the same tmux server, changes the list too — and a client that
        // believes listChanged refreshes only on notice.
        const remote = await tmux.newSession({
          name: "made-elsewhere",
          shellCommand: "cat",
        });
        await waitUntil(() => notices > 0, "new external session was not announced");
        await waitUntil(
          async () => (await controlSessionIds(fixture)).includes(remote.id),
          "topology listener did not attach to the external session",
        );
        notices = 0;

        const remotePane = (await tmux.snapshot()).panes.one({
          session: { is: { id: remote.id } },
        });
        const split = await remotePane.split({ shellCommand: "cat" });
        await waitUntil(() => notices > 0, "external pane split was not announced");
        const withSplit = (await client.listResources()).resources.map(({ uri }) => uri);
        const splitUri = `tmux://panes/${encodeURIComponent(split.id)}`;
        expect(withSplit).toContain(splitUri);
        expect(withSplit).toContain(`${splitUri}/content`);

        notices = 0;
        await split.kill();
        await waitUntil(() => notices > 0, "external pane removal was not announced");
        const withoutSplit = (await client.listResources()).resources.map(({ uri }) => uri);
        expect(withoutSplit).not.toContain(splitUri);
        expect(withoutSplit).not.toContain(`${splitUri}/content`);
        notices = 0;

        const controls = (
          await fixture.executeText([
            "list-clients",
            "-F",
            "#{client_name}\t#{client_control_mode}",
          ])
        ).stdout.filter((line) => line.endsWith("\t1"));
        if (controls.length === 0) throw new Error("No topology control client");
        for (const control of controls) {
          // eslint-disable-next-line no-await-in-loop -- each identified client must be detached.
          await fixture.executeText([
            "detach-client",
            "-t",
            control.slice(0, control.indexOf("\t")),
          ]);
        }

        // Losing the listener announces uncertainty, then reconnects without a
        // client request: a cached client has no reason to list again first.
        await waitUntil(() => notices > 0, "lost topology listeners were not announced");
        await waitUntil(async () => {
          const sessions = await controlSessionIds(fixture);
          return sessions.includes(fixture.sessionId) && sessions.includes(remote.id);
        }, "topology listeners did not recover across both sessions");
        // Drain the coalesced recovery notice before proving the next mutation.
        await new Promise((resolve) => setTimeout(resolve, 600));
        notices = 0;
        await remote.newWindow({ name: "made-after-reconnect" });
        await waitUntil(() => notices > 0, "change after listener recovery was not announced");
      });
    });
  }, 60_000);

  test("recovers a resource watch that starts with no session", async () => {
    await withServer(async (fixture) => {
      const tmux = serverFor(fixture);
      await fixture.executeText(["set-option", "-s", "exit-empty", "off"]);
      await fixture.executeText(["kill-session", "-t", fixture.sessionId]);

      await withClient(fixture, async (client) => {
        let notices = 0;
        client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
          notices += 1;
        });

        // The catalog itself may be unreadable without a row from which to
        // identify the daemon. Watch activation must survive that first read.
        await client.listResources().catch(() => undefined);
        notices = 0;

        const recovered = await tmux.newSession({
          name: "recovered",
          shellCommand: "cat",
        });
        await waitUntil(
          () => notices > 0,
          "resource watch did not announce recovery from an empty server",
        );
        const uris = (await client.listResources()).resources.map(({ uri }) => uri);
        expect(uris).toContain(sessionUri(recovered.id));
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
            arguments: {
              paneId,
              shellCommand: `cat >> ${other}`,
              toggle: true,
            },
            name: "pipe_pane",
          }),
        );
        // The caller that stopped somebody's capture is the one that most needs
        // to know it did. Reporting the request back said piping either way.
        expect(toggled.piping).toBe(false);
        await client.callTool({
          arguments: {
            command: "echo after-toggle",
            paneId,
            timeoutMs: 20_000,
          },
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
        const alive = await client.callTool({
          arguments: { paneId },
          name: "respawn_pane",
        });
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

  test("offers move_pane only as a destructive tool", async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toContain("move_pane");
      });

      await withClient(
        fixture,
        async (client) => {
          const movePane = (await client.listTools()).tools.find(
            (tool) => tool.name === "move_pane",
          );
          expect(movePane).toBeDefined();
          expect(movePane?.annotations?.destructiveHint).toBe(true);
        },
        { LIBTMUX_SAFETY: "destructive" },
      );
    });
  }, 60_000);
});
