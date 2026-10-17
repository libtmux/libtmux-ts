import { expect, test } from "bun:test";

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

test("wait_for_text names the control-mode requirement where the daemon cannot be watched", async () => {
  await withServer(async (fixture) => {
    const version = (await fixture.executeText(["display-message", "-p", "#{version}"])).stdout
      .join("")
      .trim();
    await withClient(fixture, async (client) => {
      const created = structured<{ paneId: string }>(
        await client.callTool({ arguments: { name: "older-wait" }, name: "create_session" }),
      );
      const waited = await client.callTool({
        arguments: { paneId: created.paneId, patterns: ["never-printed"], timeoutMs: 300 },
        name: "wait_for_text",
      });
      const text = JSON.stringify(waited.content);
      if (atLeast(version, 3, 7)) {
        expect(text).not.toContain("control mode needs tmux 3.7");
      } else {
        expect(waited.isError).toBe(true);
        expect(text).toContain("control mode needs tmux 3.7 or newer");
        expect(text).toContain("capture_pane");
      }
    });
  });
}, 60_000);
