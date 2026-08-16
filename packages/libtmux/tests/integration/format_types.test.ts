import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import valueTypeFixture from "../fixtures/tmux-format-value-types.json" with { type: "json" };

import { ControlMode } from "../../src/_internal/test/control_mode.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
} from "../../src/_internal/test/run_root.js";
import { TestServer } from "../../src/_internal/test/test_server.js";
import { FORMAT_SEPARATOR } from "../../src/formats.js";
import { Server } from "../../src/server.js";

import { assertOwnedSocketPath, makeTestDirectory } from "../../src/_internal/test/temp_root.js";

/**
 * Hold the declared shape of every format field to what tmux actually sends.
 *
 * `tmux-format-value-types.json` says which fields carry a number, a boolean or
 * a time rather than a string, and the typed accessors are generated from it. A
 * wrong entry there is worse than no entry at all: `pane.pid` would answer
 * `NaN`, or `pane.active` would answer `true` for a pane that is not. The
 * derivation that produced the file already got six wrong — `%0` and `$0` read
 * as integers to a regular expression, and so do `2,1` and `1#,2#` — so the
 * file is not evidence of anything until a live server agrees with it.
 *
 * Every version in the CI matrix runs this, which is the other half: a field
 * tmux 3.7 reports as a number and 3.2a leaves empty is fine, and one whose
 * shape changed between them is not.
 */

const declared = valueTypeFixture.types as Readonly<Record<string, string>>;

/** How a value of each declared type is spelled on the wire. */
const shapes: Readonly<Record<string, RegExp>> = {
  boolean: /^[01]$/u,
  number: /^-?\d+$/u,
  // Epoch seconds. Bounded below so a plain `0` or a small counter cannot pass
  // as a timestamp, and above so a field that is really a byte count cannot.
  time: /^\d{9,11}$/u,
};

/**
 * Fields the staging below exists to produce.
 *
 * Named rather than counted. An empty field is not a counterexample, so a test
 * that only forbids mismatches passes just as happily having seen nothing at
 * all; a count instead invites lowering it. These are the ones whose absence
 * means a specific piece of staging stopped working — a client, a buffer, a
 * dead pane, a pipe, a session group.
 */
const stagedFields = [
  "buffer_size",
  "client_pid",
  "client_utf8",
  "copy_cursor_x",
  "pane_dead_status",
  "pane_pipe_pid",
  "scroll_position",
  "session_group_size",
] as const;

const listCommands = [
  "list-buffers",
  "list-clients",
  "list-panes",
  "list-sessions",
  "list-windows",
] as const;

async function withServer(
  name: string,
  body: (fixture: TestServer, server: Server) => Promise<void>,
): Promise<void> {
  const parent = await makeTestDirectory("ltx-fmttypes-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: name });
        assertOwnedSocketPath(fixture.socketPath);
        const server = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        await runWithCleanup(
          () => body(fixture, server),
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

/**
 * Every row one list command reports, as one field per token in order.
 *
 * Empty is not a counterexample: tmux leaves a field blank when it does not
 * apply — `pane_dead_status` on a living pane, `client_width` with nothing
 * attached — so the shapes are checked against what arrived, and
 * {@link stagedFields} covers the case of nothing arriving at all.
 */
async function valuesFor(
  server: Server,
  command: string,
  tokens: readonly string[],
): Promise<readonly (readonly string[])[]> {
  const format = tokens.map((token) => `#{${token}}`).join(FORMAT_SEPARATOR);
  const listed = await server
    .cmd(command, ["-F", format], { target: null })
    .catch(() => [] as string[]);
  return listed.map((row) => row.split(FORMAT_SEPARATOR));
}

/** A single field's value, for the staging loop that polls one of them. */
async function oneValue(server: Server, command: string, token: string): Promise<string | null> {
  const rows = await valuesFor(server, command, [token]);
  return rows.map((row) => row[0] ?? "").find((value) => value !== "") ?? null;
}

/** Put the server into a state where the awkward families report something. */
async function stage(fixture: TestServer, server: Server): Promise<void> {
  const session = fixture.sessionName;
  await server.cmd("new-window", [], { target: session });
  await server.cmd("split-window", [], { target: session });
  await server.cmd("set-buffer", ["-b", "probe", "sample text"], { target: null });

  // A session group, for the `session_group_*` family: `-t` on an existing
  // session is what makes one.
  await server.cmd("new-session", ["-d", "-s", "grouped", "-t", session], { target: null });

  // A pane that has exited but is still listed, for `pane_dead_*`.
  // `remain-on-exit` has to be set before the process ends, or tmux reaps it.
  await server.cmd("set-option", ["-t", session, "remain-on-exit", "on"], { target: null });
  await server.cmd("split-window", ["-d", "false"], { target: session });

  // A pipe, for `pane_pipe_pid`. The reader outlives the assertion.
  await server.cmd("pipe-pane", ["-t", session, "cat > /dev/null"], { target: null });

  // Copy mode, for the cursor and selection coordinates. tmux only publishes
  // them while a pane is in the mode, so without this the whole family is
  // empty and their declared shapes go unexamined.
  await server.cmd("copy-mode", ["-t", `${session}.0`], { target: null });

  // tmux marks the pane dead asynchronously; wait for it rather than sleeping,
  // so a slow machine cannot decide the result.
  const deadline = Date.now() + 15_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling one field to a bound.
    const status = await oneValue(server, "list-panes", "pane_dead_status");
    if (status !== null) return;
    if (Date.now() > deadline) return;
    // eslint-disable-next-line no-await-in-loop -- as above.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("declared format value types", () => {
  test("every declared field carries the shape it claims, over a populated server", async () => {
    await withServer("fmt", async (fixture, server) => {
      await stage(fixture, server);

      // A client makes the whole `client_*` family reportable; without one
      // they are all empty and the test would pass by not looking.
      await ControlMode.run({ server: fixture, targetSession: fixture.sessionName }, async () => {
        const mismatches: string[] = [];
        const observed = new Set<string>();

        // One command per listing rather than one per field: `-F` takes every
        // token at once, which is both how the library itself reads a row and
        // the difference between five commands and six hundred.
        const tokens = Object.keys(declared);
        const rows = (
          await Promise.all(listCommands.map((command) => valuesFor(server, command, tokens)))
        ).flat();

        for (const [index, token] of tokens.entries()) {
          const type = declared[token]!;
          const shape = shapes[type];
          if (shape === undefined) {
            mismatches.push(`${token} declares an unknown type ${type}`);
            continue;
          }
          const values = rows.map((row) => row[index] ?? "").filter((value) => value !== "");
          if (values.length === 0) continue;
          observed.add(token);
          const wrong = values.find((value) => !shape.test(value));
          if (wrong !== undefined) {
            mismatches.push(`${token} declares ${type} but tmux sent ${JSON.stringify(wrong)}`);
          }
        }

        expect(mismatches).toEqual([]);
        expect(stagedFields.filter((token) => !observed.has(token))).toEqual([]);
      });
    });
  }, 120_000);

  test("declares no field that this port does not carry", async () => {
    const known = new Set(
      (
        (await Bun.file(
          new URL("../fixtures/python-0.62.0-format-fields.json", import.meta.url).pathname,
        ).json()) as { fields: { token: string }[] }
      ).fields.map(({ token }) => token),
    );
    const strays = Object.keys(declared).filter((token) => !known.has(token));
    expect(strays).toEqual([]);
  });
});
