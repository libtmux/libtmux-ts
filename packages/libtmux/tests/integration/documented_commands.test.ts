import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";
import { Server } from "../../src/server.js";
import type { Pane } from "../../src/pane.js";
import type { Session } from "../../src/session.js";
import type { Window } from "../../src/window.js";

/**
 * The `cmd()` examples, run rather than compiled.
 *
 * `typecheck:symbols` proves an example compiles, which
 * `cmd("rename-session -- new")` did for as long as it shipped: a string where a
 * string is wanted, and tmux answering `unknown command`. Compiling proves the
 * shape; only running proves the claim.
 *
 * The calls are read out of the source, so the example this runs is the one the
 * documentation shows. Their arguments are parsed as JSON rather than evaluated
 * — an example that cannot be read that way fails here, which is the right
 * answer for a line whose whole job is to be copied.
 */
const HANDLES = ["server", "session", "window", "pane"] as const;

interface DocumentedCall {
  readonly args: readonly string[];
  readonly command: string;
  readonly source: string;
}

function documentedCalls(source: string, receiver: string): readonly DocumentedCall[] {
  const calls: DocumentedCall[] = [];
  const pattern = new RegExp(String.raw`^\s*\*\s*await ${receiver}\.cmd\((.*)\);\s*$`, "gmu");
  for (const match of source.matchAll(pattern)) {
    const parsed: unknown = JSON.parse(`[${match[1]!}]`);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      throw new Error(`cmd example is not literal enough to run: ${match[0]}`);
    }
    const args = parsed[1] ?? [];
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
      throw new Error(`cmd example arguments are not string literals: ${match[0]}`);
    }
    calls.push({ args: args as string[], command: parsed[0], source: match[0].trim() });
  }
  return calls;
}

async function sourceOf(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../src/${name}.ts`, import.meta.url)), "utf8");
}

async function withServer(body: (server: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-doccmd-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "doccmd" });
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

describe("documented cmd examples", () => {
  test("every cmd() example in the public docs runs against real tmux", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const snapshot = await server.snapshot();
      const receivers: Record<(typeof HANDLES)[number], Pane | Server | Session | Window> = {
        pane: snapshot.panes.one(),
        server,
        session: snapshot.sessions.one(),
        window: snapshot.windows.one(),
      };

      const ran: string[] = [];
      for (const name of HANDLES) {
        // eslint-disable-next-line no-await-in-loop -- each example runs against the state the last one left.
        const calls = documentedCalls(await sourceOf(name), name);
        expect(calls).not.toBeEmpty();
        for (const call of calls) {
          // eslint-disable-next-line no-await-in-loop -- as above.
          await receivers[name].cmd(call.command, call.args);
          ran.push(call.source);
        }
      }

      // Counted, so a doc that loses its example cannot pass by running nothing.
      expect(ran).toHaveLength(HANDLES.length);
    });
  }, 60_000);
});
