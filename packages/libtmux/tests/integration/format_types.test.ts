import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import valueTypeFixture from "../fixtures/tmux-format-value-types.json" with { type: "json" };

import { formatFieldsForListCommand } from "../../src/_internal/codec/format_registry.js";
import { GENERATED_FORMAT_FIELDS } from "../../src/_generated/format_fields.js";
import { compareTmuxVersions, parseTmuxVersion } from "../../src/_internal/runtime/tmux_version.js";
import {
  ControlMode,
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  assertOwnedSocketPath,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { FORMAT_SEPARATOR } from "../../src/formats.js";
import { Server } from "../../src/server.js";

/**
 * Hold the declared shape of every format field to what tmux actually sends.
 *
 * The typed accessors are generated from `tmux-format-value-types.json`, so a
 * wrong entry there makes `pane.pid` answer `NaN` or `pane.active` answer
 * `true` for a pane that is not. The file is derived from tmux's format.c,
 * which cannot see what a given tmux does; this can.
 */

const declared = valueTypeFixture.types as Readonly<Record<string, string>>;

/** How a value of each declared type is spelled on the wire. */
const shapes: Readonly<Record<string, RegExp>> = {
  boolean: /^[01]$/u,
  number: /^-?\d+$/u,
  "pane-id": /^%\d+$/u,
  "session-id": /^\$\d+$/u,
  // Epoch seconds. Bounded below so a plain `0` or a small counter cannot pass
  // as a timestamp, and above so a field that is really a byte count cannot.
  time: /^\d{9,11}$/u,
  "window-id": /^@\d+$/u,
};

/**
 * Fields the staging exists to produce.
 *
 * An empty field is not a counterexample, so forbidding mismatches alone passes
 * just as happily having seen nothing. Each of these goes empty when a specific
 * piece of staging stops working.
 */
const stagedFields = [
  "client_pid",
  "client_utf8",
  "pane_dead_status",
  "pane_pipe_pid",
  "session_group_size",
] as const;

/** The four listings a snapshot is made of. */
const listCommands = ["list-clients", "list-panes", "list-sessions", "list-windows"] as const;

/**
 * Declared fields no listing carries, so no snapshot ever populates them and
 * this cannot check their shape against a live server.
 *
 * Pinned rather than skipped. Their accessors exist and answer null forever, so
 * the set is a property of the snapshot's four listings; if one starts arriving
 * — a fifth listing, or tmux moving a field's scope — this fails and the shape
 * gets checked like every other.
 */
const unobservable = [
  "buffer_size",
  "copy_cursor_x",
  "copy_cursor_y",
  "scroll_position",
  "selection_end_x",
  "selection_end_y",
  "selection_start_x",
  "selection_start_y",
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

  // `-t` on an existing session makes a session group.
  await server.cmd("new-session", ["-d", "-s", "grouped", "-t", session], { target: null });

  // `remain-on-exit` must be set before the process ends, or tmux reaps it.
  await server.cmd("set-option", ["-t", session, "remain-on-exit", "on"], { target: null });
  await server.cmd("split-window", ["-d", "false"], { target: session });

  // A pipe, for `pane_pipe_pid`.
  await server.cmd("pipe-pane", ["-t", session, "cat > /dev/null"], { target: null });

  // tmux publishes the copy-mode coordinates only while a pane is in the mode.
  await server.cmd("copy-mode", ["-t", `${session}.0`], { target: null });

  // tmux marks the pane dead asynchronously.
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

      // Without a client the whole `client_*` family is empty.
      await ControlMode.run({ server: fixture, targetSession: fixture.sessionName }, async () => {
        const mismatches: string[] = [];
        const observed = new Set<string>();

        // The questions the library asks, from the same table. Not every token
        // of every command: `#{client_activity}` through `list-panes` takes
        // tmux 3.2a's server down.
        const version = (
          await server.cmd("display-message", ["-p", "#{version}"], {
            target: null,
          })
        )[0]!;
        const asked = listCommands.map((command) => ({
          command,
          tokens: formatFieldsForListCommand(command, version)
            .map(({ token }) => token)
            .filter((token) => token in declared),
        }));
        const seen = new Map<string, string[]>();
        for (const { command, tokens } of asked) {
          if (tokens.length === 0) continue;
          // eslint-disable-next-line no-await-in-loop -- one listing at a time; each is a separate tmux command.
          for (const row of await valuesFor(server, command, tokens)) {
            for (const [index, token] of tokens.entries()) {
              const value = row[index] ?? "";
              if (value === "") continue;
              const values = seen.get(token) ?? [];
              values.push(value);
              seen.set(token, values);
            }
          }
        }

        for (const [token, type] of Object.entries(declared)) {
          const shape = shapes[type];
          if (shape === undefined) {
            mismatches.push(`${token} declares an unknown type ${type}`);
            continue;
          }
          const values = seen.get(token);
          if (values === undefined) continue;
          observed.add(token);
          const wrong = values.find((value) => !shape.test(value));
          if (wrong !== undefined) {
            mismatches.push(`${token} declares ${type} but tmux sent ${JSON.stringify(wrong)}`);
          }
        }

        expect(mismatches).toEqual([]);
        // A field the registry holds back for this version — `pane_pipe_pid`
        // arrived in 3.7 — is absent because nothing asked for it.
        const requested = new Set<string>(asked.flatMap(({ tokens }) => tokens));
        expect(
          stagedFields.filter((token) => requested.has(token) && !observed.has(token)),
        ).toEqual([]);

        // Every declared field is either checked above, named as one this
        // snapshot cannot reach, or withheld by the registry because this tmux
        // is older than the field. Nothing is quietly unverified — and the
        // third case is why this has to run on the floor and not only on the
        // newest release: on 3.2a ten fields fall into it.
        const withheld = new Set<string>(
          GENERATED_FORMAT_FIELDS.filter(
            (field) =>
              compareTmuxVersions(parseTmuxVersion(version), parseTmuxVersion(field.since)) < 0,
          ).map(({ token }) => String(token)),
        );
        expect(
          Object.keys(declared)
            .filter((token) => !requested.has(token) && !withheld.has(token))
            .sort(),
        ).toEqual([...unobservable].sort());
      });
    });
  }, 120_000);

  test("declares no field that this port does not carry", async () => {
    // Both sources, because the vocabulary is both. The Python fixture is the
    // parity oracle and the tmux fixture is what this port adds beyond it; a
    // value type for a field in neither is a claim about nothing.
    const read = async (name: string): Promise<readonly string[]> =>
      (
        (await Bun.file(new URL(`../fixtures/${name}`, import.meta.url).pathname).json()) as {
          fields: { token: string }[];
        }
      ).fields.map(({ token }) => token);
    const known = new Set([
      ...(await read("python-0.62.0-format-fields.json")),
      ...(await read("tmux-format-fields.json")),
    ]);
    const strays = Object.keys(declared).filter((token) => !known.has(token));
    expect(strays).toEqual([]);
  });
});
