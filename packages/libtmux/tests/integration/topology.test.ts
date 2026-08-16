import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import type { Pane } from "../../src/pane.js";
import { PaneDirection, ResizeAdjustmentDirection, WindowDirection } from "../../src/constants.js";
import { Server } from "../../src/server.js";

import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-topology-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "topo" });
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

/** Poll a pane until its contents satisfy a predicate or the deadline passes. */
async function captureUntil(
  pane: Pane,
  matches: (lines: readonly string[]) => boolean,
  attempts = 150,
): Promise<readonly string[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    const lines = await pane.capture();
    if (matches(lines)) return lines;
    // eslint-disable-next-line no-await-in-loop -- each wait follows the capture before it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pane never reached the expected contents");
}

describe("window and pane topology", () => {
  test("renames a window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();

      await window.rename("renamed");

      expect((await server.snapshot()).windows.count({ name: "renamed" })).toBe(1);
    });
  }, 40_000);

  test("links a window into a second session and unlinks one placement", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const other = await server.newSession({ name: "other" });
      const window = (await server.snapshot()).windows
        .filter((candidate) => candidate.sessionName === fixture.sessionName)
        .one();

      await window.link({ index: 9, session: "other" });

      const linked = (await server.snapshot()).windows.filter(
        (candidate) => candidate.id === window.id,
      );
      expect(linked.length).toBe(2);

      // Unlinking the second placement leaves the original intact.
      const placement = linked.filter((candidate) => candidate.sessionId === other.id).one();
      await placement.unlink();

      const afterUnlink = (await server.snapshot()).windows.filter(
        (candidate) => candidate.id === window.id,
      );
      expect(afterUnlink.length).toBe(1);
    });
  }, 40_000);

  test("moves a window to an explicit index", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();

      await window.move({ index: 7, session: fixture.sessionName });

      const moved = (await server.snapshot()).windows
        .filter((candidate) => candidate.id === window.id)
        .one();
      expect(moved.index).toBe(7);
    });
  }, 40_000);

  test("applies a layout and resizes a pane", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();
      await window.split();

      await window.selectLayout("main-vertical");
      const panes = (await server.snapshot()).panes.toArray();
      expect(panes.length).toBe(2);

      const first = panes[0];
      if (first === undefined) throw new Error("expected a pane to resize");
      await first.resize({ width: 40 });

      const resized = (await server.snapshot()).panes
        .filter((candidate) => candidate.id === first.id)
        .one();
      expect(Number(resized.width)).toBeGreaterThan(0);
    });
  }, 40_000);

  test("swaps two windows", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      const second = await session.newWindow({ name: "second" });
      const first = (await server.snapshot()).windows
        .filter((candidate) => candidate.id !== second.id)
        .one();
      const firstIndex = first.index;
      const secondIndex = second.index;

      await first.swapWith(second);

      const after = await server.snapshot();
      expect(after.windows.filter((candidate) => candidate.id === first.id).one().index).toBe(
        secondIndex,
      );
      expect(after.windows.filter((candidate) => candidate.id === second.id).one().index).toBe(
        firstIndex,
      );
    });
  }, 40_000);

  test("selects the pane and window it is asked for", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "selecting" });
      const first = (await server.snapshot()).sessions.one({ id: session.id }).windows.one();
      const second = await session.newWindow({ name: "second" });
      const lower = await first.split();

      await second.select();
      const afterSecond = (await server.snapshot()).sessions.one({ id: session.id });
      expect(afterSecond.windows.one({ active: "1" }).id).toBe(second.id);

      await first.select();
      await lower.select();

      const settled = (await server.snapshot()).sessions.one({ id: session.id });
      expect(settled.windows.one({ active: "1" }).id).toBe(first.id);
      expect(settled.windows.one({ id: first.id }).panes.one({ active: "1" }).id).toBe(lower.id);
      await session.kill();
    });
  }, 60_000);

  test("respawns a pane, replacing what runs in it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "respawning" });
      const pane = (await server.snapshot()).sessions.one({ id: session.id }).panes.one();

      // Without `kill`, tmux refuses to respawn a pane whose process is alive,
      // which is the whole reason the flag exists.
      await expect(pane.respawn("sleep 30")).rejects.toThrow();
      await pane.respawn("sleep 30", { kill: true });

      // The replacement process has to be scheduled before tmux reports it as
      // the pane's foreground command, so this converges rather than asserting
      // on the instant the respawn returns.
      let command: string | null = null;
      for (let attempt = 0; attempt < 100 && command !== "sleep"; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- observed within one fixed bound.
        command = (await server.snapshot()).panes.one({ id: pane.id }).currentCommand;
        if (command === "sleep") break;
        // eslint-disable-next-line no-await-in-loop -- each read follows its wait.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(command).toBe("sleep");
      await session.kill();
    });
  }, 60_000);

  test("reports pane geometry and relations that agree with each other", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = await server.newSession({ name: "geometry" });
      const window = (await server.snapshot()).sessions.one({ id: session.id }).windows.one();
      await window.split(); // a vertical split: one pane above, one below

      const settled = (await server.snapshot()).windows.one({ id: window.id });
      const panes = settled.panes.toArray();
      expect(panes).toHaveLength(2);

      const [upper, lower] = panes as [(typeof panes)[0], (typeof panes)[0]];

      // A vertical split puts one pane at the top and the other at the bottom,
      // and both span the full width. Asserting the flags against each other
      // catches a mis-mapped field that a single-pane check would not.
      expect(upper.atTop).toBe(true);
      expect(upper.atBottom).toBe(false);
      expect(lower.atTop).toBe(false);
      expect(lower.atBottom).toBe(true);
      for (const pane of panes) {
        expect(pane.atLeft).toBe(true);
        expect(pane.atRight).toBe(true);
        expect(pane.width).toBe(settled.width);
        expect(pane.height).toBeGreaterThan(0);
      }
      expect((upper.height ?? 0) + (lower.height ?? 0)).toBeLessThanOrEqual(settled.height ?? 0);
      expect(panes.map((pane) => pane.index)).toEqual([0, 1]);
      expect(upper.title).not.toBeNull();
      expect(upper.pipe).toBe(false);

      // Relations resolve back to the handles they came from. They are typed
      // as possibly-undefined because a projection need not contain the far
      // side; here it does, so a missing one is a failure worth naming.
      expect(upper.window?.id).toBe(window.id);
      expect(upper.session?.id).toBe(session.id);
      expect(settled.session?.id).toBe(session.id);
      // linkedSessions is the relation, not the count field: a window linked
      // into one session resolves to exactly that session.
      expect(settled.linkedSessions.count()).toBe(1);
      expect(settled.linkedSessions.one().id).toBe(session.id);
      await session.kill();
    });
  }, 60_000);

  test("sets a pane title that tmux reports back", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      await pane.setTitle("build output");

      const reported = await pane.cmd("display-message", ["-p", "#{pane_title}"]);
      expect(reported[0]).toBe("build output");
      expect((await pane.refreshed()).title).toBe("build output");
    });
  }, 30_000);

  test("keeps a title that would otherwise look like a flag", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      await pane.setTitle("-T");

      const reported = await pane.cmd("display-message", ["-p", "#{pane_title}"]);
      expect(reported[0]).toBe("-T");
    });
  }, 30_000);

  test("names one active pane per session, not one per window", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const first = (await server.snapshot()).sessions.one();
      await first.newWindow({ name: "second" });
      const session = (await server.snapshot()).sessions.one();

      // `pane_active` is scoped to a window, so the flat filter finds one pane
      // in every window. The accessor is the reason that is not a trap.
      expect(session.windows.length).toBe(2);
      expect(session.panes.where({ active: "1" }).length).toBe(2);

      const active = session.activePane;
      expect(active).toBeDefined();
      expect(session.activeWindow?.id).toBe(session.windows.where({ active: "1" }).one().id);
      expect(active?.windowId).toBe(session.activeWindow?.id);
    });
  }, 30_000);

  test("follows the active pane as tmux moves it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();
      const created = await pane.split();

      await created.select();

      const window = (await server.snapshot()).windows.one();
      expect(window.activePane?.id).toBe(created.id);
    });
  }, 30_000);

  test("describes each handle by what identifies it", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const snapshot = await server.snapshot();
      const session = snapshot.sessions.one();
      const window = snapshot.windows.one();
      const pane = snapshot.panes.one();

      // A handle's own properties are its methods, so without this the default
      // rendering is `[object Object]` and a wall of `[Function]`.
      expect(String(session)).toBe(`Session(${session.id} ${session.name ?? ""})`);
      expect(String(window)).toContain(`Window(${window.id} `);
      expect(String(window)).toContain(`Session(${session.id} `);
      expect(String(pane)).toContain(`Pane(${pane.id} `);
      expect(String(pane)).toContain(`Window(${window.id} `);
      expect(String(server)).toContain("Server(");
    });
  }, 30_000);

  test("uses the same description when a runtime inspects a handle", async () => {
    await withServer(async (fixture) => {
      const pane = (await serverFor(fixture).snapshot()).panes.one();

      // Node and Bun both consult this key, which is what makes console.log
      // useful rather than a dump of every method.
      const inspected = (pane as unknown as Record<symbol, unknown>)[
        Symbol.for("nodejs.util.inspect.custom")
      ];

      expect(typeof inspected).toBe("function");
      expect((inspected as (this: Pane) => string).call(pane)).toBe(pane.toString());
    });
  }, 30_000);

  test("splits on the side the direction names", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const origin = (await server.snapshot()).panes.one();

      // Above and left are the two tmux reaches only by pairing an axis with
      // `-b`, so a boolean cannot express them at all.
      const above = await origin.split({ direction: PaneDirection.Above });
      const left = await origin.split({ direction: PaneDirection.Left });
      const below = await origin.split({ direction: PaneDirection.Below });
      const right = await origin.split({ direction: PaneDirection.Right });

      const reported = async (pane: Pane): Promise<readonly string[]> =>
        pane.cmd("display-message", ["-p", "#{pane_top} #{pane_left}"]);

      // The new pane starts at the top when it went above, and at column zero
      // when it went left; the opposite directions start past the origin.
      expect((await reported(above))[0]?.split(" ")[0]).toBe("0");
      expect((await reported(left))[0]?.split(" ")[1]).toBe("0");
      expect(Number((await reported(below))[0]?.split(" ")[0])).toBeGreaterThan(0);
      expect(Number((await reported(right))[0]?.split(" ")[1])).toBeGreaterThan(0);
    });
  }, 40_000);

  test("places a window beside the session's current one", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const session = (await server.snapshot()).sessions.one();
      const anchor = await session.newWindow({ name: "anchor" });
      // tmux measures from the session's selected window, so the anchor has to
      // be the selected one for "after" to mean after it.
      await anchor.select();
      const anchorIndex = Number(anchor.index);

      const after = await session.newWindow({
        direction: WindowDirection.After,
        name: "after",
      });

      expect(Number(after.index)).toBe(anchorIndex + 1);
    });
  }, 40_000);

  test("resizes by a direction and a count, not only to a size", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const origin = (await server.snapshot()).panes.one();
      await origin.split({ direction: PaneDirection.Below });
      const before = Number((await origin.cmd("display-message", ["-p", "#{pane_height}"]))[0]);

      await origin.resize({ amount: 3, direction: ResizeAdjustmentDirection.Down });

      const after = Number((await origin.cmd("display-message", ["-p", "#{pane_height}"]))[0]);
      expect(after).toBe(before + 3);
    });
  }, 40_000);

  test("resizes by a direction and to a size in one call", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const origin = (await server.snapshot()).panes.one();
      // A width only moves when a pane sits beside this one, and a height only
      // when one sits below it, so both splits have to exist for the combined
      // call to be observable at all.
      await origin.split({ direction: PaneDirection.Right });
      await origin.split({ direction: PaneDirection.Below });
      const sizeOf = async (): Promise<readonly number[]> =>
        (await origin.cmd("display-message", ["-p", "#{pane_width} #{pane_height}"]))[0]
          ?.split(" ")
          .map(Number) ?? [];
      const [, beforeHeight] = await sizeOf();

      await origin.resize({ amount: 2, direction: ResizeAdjustmentDirection.Down, width: 20 });

      const [width, height] = await sizeOf();
      expect(width).toBe(20);
      expect(height).toBe((beforeHeight ?? 0) + 2);
    });
  }, 40_000);

  test("resizes a window to a size of its own", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();
      // A window follows its attached clients under the default `window-size`,
      // which would overwrite the size asked for here before it is read back.
      await window.setOption("window-size", "manual");

      await window.resize({ height: 30, width: 100 });

      const size = await window.cmd("display-message", ["-p", "#{window_width}x#{window_height}"]);
      expect(size[0]).toBe("100x30");
    });
  }, 40_000);

  test("restarts the command a window is running", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const window = (await server.snapshot()).windows.one();
      const pidOf = async (): Promise<string | undefined> =>
        (await window.cmd("display-message", ["-p", "#{pane_pid}"]))[0];
      const before = await pidOf();

      // The window is still running its shell, so respawning it without `kill`
      // is what tmux refuses; the pid changing is what proves it restarted.
      await window.respawn("sh", { kill: true });

      expect(await pidOf()).not.toBe(before);
    });
  }, 40_000);

  test("sets variables in the process it respawns", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();

      await pane.respawn(`sh -c 'printf "probe=%s\\n" "$LIBTMUX_PROBE"; sleep 30'`, {
        environment: { LIBTMUX_PROBE: "respawned" },
        kill: true,
      });

      // Reading it back through the pane is the only evidence available: the
      // variable belongs to the respawned process, not to the tmux server.
      const lines = await captureUntil(pane, (current) =>
        current.some((line) => line.includes("probe=respawned")),
      );
      expect(lines.some((line) => line.includes("probe=respawned"))).toBe(true);
    });
  }, 40_000);

  test("cycles a window through its layout presets", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();
      await pane.split();
      const window = (await server.snapshot()).windows.one();
      const layoutOf = async (): Promise<string | undefined> =>
        (await window.cmd("display-message", ["-p", "#{window_layout}"]))[0];
      const before = await layoutOf();

      await window.nextLayout();
      const stepped = await layoutOf();
      await window.previousLayout();
      const back = await layoutOf();

      // Stepping is not an exact inverse — tmux redistributes cells and the
      // sizes land a row off — so each step must change the layout rather than
      // restore a byte-identical one.
      expect(stepped).not.toBe(before);
      expect(back).not.toBe(stepped);
      expect(window.panes.length).toBe(2);
    });
  }, 40_000);

  test("rotates the panes through a window's layout", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const origin = (await server.snapshot()).panes.one();
      await origin.split();
      const window = (await server.snapshot()).windows.one();
      const order = async (): Promise<readonly string[]> =>
        (await window.panes.toArray()).map((pane) => pane.id);
      const before = await order();

      await window.rotate();

      // The layout is unchanged; what sits in each position moved.
      const after = (await (await server.snapshot()).windows.one().panes)
        .toArray()
        .map((p) => p.id);
      expect(after).toHaveLength(before.length);
      expect(new Set(after)).toEqual(new Set(before));
    });
  }, 40_000);

  test("pastes a buffer into a pane as input", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const pane = (await server.snapshot()).panes.one();
      await server.setBuffer("greeting", "echo pasted-from-buffer\n");

      await pane.pasteBuffer("greeting");

      const lines = await captureUntil(pane, (captured) =>
        captured.some((line) => line.includes("pasted-from-buffer")),
      );
      expect(lines.some((line) => line.includes("pasted-from-buffer"))).toBe(true);
    });
  }, 40_000);
});
