import { expect, test } from "bun:test";

import { testControl } from "../../libtmux/tests/support/tmux_release.js";
import { structured, withClient, withServer } from "./support/server_harness.js";

/** The release of the tmux the fixture runs, as numbers. */
function release(version: string): readonly [number, number] {
  const match = /^(?:next-)?(\d+)\.(\d+)/u.exec(version);
  return [Number(match?.[1]), Number(match?.[2])];
}

const atLeast = (version: string, major: number, minor: number): boolean => {
  const [have, has] = release(version);
  return have > major || (have === major && has >= minor);
};

test("run_shell_command stages its script in a buffer only where one can be deleted by name", async () => {
  await withServer(async (fixture) => {
    const version = (await fixture.executeText(["display-message", "-p", "#{version}"])).stdout
      .join("")
      .trim();
    // load-buffer's after-hook marks that a script was staged.
    await fixture.executeText(["set-hook", "-g", "after-load-buffer", "set -g @staged yes"]);
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({ arguments: { name: "older-tmux" }, name: "create_session" }),
      );
      const run = structured<{ outcome: string; output: string }>(
        await client.callTool({
          arguments: { command: "printf 'ltx-older\\n'", paneId: created.paneId },
          name: "run_shell_command",
        }),
      );
      expect(run).toMatchObject({ outcome: "completed", output: "ltx-older" });
    });
    const staged = (await fixture.executeText(["show-options", "-gqv", "@staged"])).stdout
      .join("")
      .trim();
    expect(staged).toBe(atLeast(version, 3, 4) ? "yes" : "");
  });
}, 60_000);

test("wait_for_text polls the pane where the daemon cannot be watched", async () => {
  await withServer(async (fixture) => {
    const version = (await fixture.executeText(["display-message", "-p", "#{version}"])).stdout
      .join("")
      .trim();
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({ arguments: { name: "older-wait" }, name: "create_session" }),
      );
      const waiting = client.callTool({
        arguments: { paneId: created.paneId, patterns: ["ltx-polled-ok"], timeoutMs: 5000 },
        name: "wait_for_text",
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fixture.executeText([
        "send-keys",
        "-t",
        created.paneId,
        "printf 'ltx-polled-%s\\n' ok",
        "Enter",
      ]);
      const waited = await waiting;
      expect(waited.isError).not.toBe(true);
      expect(JSON.stringify(waited.content)).toContain("ltx-polled-ok");
    });
    // Below 3.7 nothing attached to watch it.
    if (!atLeast(version, 3, 7)) {
      const clients = (await fixture.executeText(["list-clients"])).stdout.join("");
      expect(clients).toBe("");
    }
  });
}, 60_000);

test("wait_for_text joins wrapped rows when it polls, as the control path does", async () => {
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({ arguments: { name: "older-wrap" }, name: "create_session" }),
      );
      await fixture.executeText(["resize-window", "-t", created.paneId, "-x", "80"]);
      const width = (
        await fixture.executeText(["display-message", "-p", "-t", created.paneId, "#{pane_width}"])
      ).stdout
        .join("")
        .trim();
      expect(width).toBe("80");
      // The whole token is wider than the pane, so no single row holds it.
      const token = `ltx-wrap-${"0".repeat(70)}END`;
      const waiting = client.callTool({
        arguments: { paneId: created.paneId, patterns: [token], timeoutMs: 8000 },
        name: "wait_for_text",
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fixture.executeText([
        "send-keys",
        "-t",
        created.paneId,
        "printf 'ltx-wrap-%s%s\\n' \"$(printf '%070d' 0)\" END",
        "Enter",
      ]);
      const waited = await waiting;
      expect(structured<{ outcome: string }>(waited).outcome).toBe("matched");
    });
  });
}, 60_000);

test("wait_for_text reports a pane killed mid-wait as pane_died, whichever path waits", async () => {
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({ arguments: { name: "older-died" }, name: "create_session" }),
      );
      // A second pane keeps the session, as the one that dies is not the last.
      await fixture.executeText(["split-window", "-d", "-t", created.paneId]);
      const waiting = client.callTool({
        arguments: { paneId: created.paneId, patterns: ["ltx-never-printed"], timeoutMs: 12000 },
        name: "wait_for_text",
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fixture.executeText(["kill-pane", "-t", created.paneId]);
      const waited = await waiting;
      expect(waited.isError).not.toBe(true);
      expect(structured<{ outcome: string }>(waited).outcome).toBe("pane_died");
    });
  });
}, 60_000);

test("wait_for_text reports pane_died with the output so far when the server is killed mid-wait", async () => {
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({ arguments: { name: "server-gone" }, name: "create_session" }),
      );
      const waiting = client.callTool({
        arguments: { paneId: created.paneId, patterns: ["ltx-never-printed"], timeoutMs: 12000 },
        name: "wait_for_text",
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fixture.executeText([
        "send-keys",
        "-t",
        created.paneId,
        "printf 'ltx-before-kill\\n'",
        "Enter",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await fixture.executeText(["kill-server"]).catch(() => undefined);
      const waited = await waiting;
      expect(waited.isError).not.toBe(true);
      expect(structured<{ outcome: string }>(waited).outcome).toBe("pane_died");
      expect(JSON.stringify(waited.content)).toContain("ltx-before-kill");
    });
  });
}, 60_000);

// The stream ending is not the pane ending: the caller is told to start again,
// which is right while the pane is still there to be read.
testControl(
  "wait_for_text reports a dropped stream as stream_lost while its pane survives",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const created = structured<{ paneId: string }>(
          await client.callTool({ arguments: { name: "stream-drop" }, name: "create_session" }),
        );
        const waiting = client.callTool({
          arguments: { paneId: created.paneId, patterns: ["ltx-never-printed"], timeoutMs: 12000 },
          name: "wait_for_text",
        });
        // The wait holds the only control client; detaching it drops the stream.
        let clients = "";
        for (let tries = 0; clients === "" && tries < 50; tries += 1) {
          // eslint-disable-next-line no-await-in-loop -- each look follows the last.
          await new Promise((resolve) => setTimeout(resolve, 100));
          // eslint-disable-next-line no-await-in-loop -- each look follows the last.
          clients = (await fixture.executeText(["list-clients", "-F", "#{client_name}"])).stdout
            .join("")
            .trim();
        }
        expect(clients).not.toBe("");
        await fixture.executeText(["detach-client", "-t", clients.split("\n")[0] as string]);
        const waited = await waiting;
        expect(waited.isError).not.toBe(true);
        expect(structured<{ outcome: string }>(waited).outcome).toBe("stream_lost");
        const alive = (
          await fixture.executeText(["display-message", "-p", "-t", created.paneId, "#{pane_id}"])
        ).stdout
          .join("")
          .trim();
        expect(alive).toBe(created.paneId);
      });
    });
  },
  60_000,
);
