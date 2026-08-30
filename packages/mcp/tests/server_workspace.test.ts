import { describe, expect, test } from "bun:test";

import { structured, toolText, withClient, withServer } from "./support/server_harness.js";

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
          arguments: {
            session: fixture.sessionName,
            windows: [{ name: "one" }],
          },
          name: "build_workspace",
        });
        expect((refused as { isError?: boolean }).isError).toBe(true);
        expect(toolText(refused)).toContain("already exists");
      });
    });
  }, 60_000);
});
