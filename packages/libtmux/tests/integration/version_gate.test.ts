import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { WHERE_FIELDS_V1, type WhereField } from "../../src/_generated/where_fields.js";
import {
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
  makeTestDirectory,
} from "../../src/_internal/test/testkit.js";

import { compareTmuxVersions, parseTmuxVersion } from "../../src/_internal/runtime/tmux_version.js";
import { VersionTooLow } from "../../src/exc.js";
import { Server } from "../../src/server.js";

/**
 * A query naming a field the server predates is refused, not answered empty.
 *
 * tmux answers for the fields its release knows and says nothing about the
 * rest, so a criterion on a newer field used to match nothing — the same
 * answer as "no pane has this", which is a different statement. The typed row
 * already drew that line by answering `null` rather than `false`; this is the
 * same line drawn for queries.
 *
 * Written against whichever tmux is installed rather than a fixed version, so
 * it exercises the refusal on every release in the matrix that predates a
 * field and the ordinary path on every release that has one.
 */

function serverFor(fixture: TestServer): Server {
  return new Server({
    environment: fixture.controllerEnvironment,
    socketPath: fixture.socketPath,
    tmuxBin: fixture.tmuxExecutable,
  });
}

function criterionFor(domain: WhereField["domain"]): string {
  switch (domain) {
    case "boolean":
    case "number":
      return "0";
    case "time":
      return "1";
    case "pane-id":
      return "%0";
    case "session-id":
      return "$0";
    case "window-id":
      return "@0";
    case "string":
      return "x";
  }
}

async function withServer(body: (fixture: TestServer) => Promise<void>): Promise<void> {
  const parent = await makeTestDirectory("ltx-version-gate-");
  const published = process.env.LIBTMUX_TEST_RUN_ROOT;
  const runRoot = published ?? join(parent, "run, root");
  if (published === undefined) await prepareRunRoot(runRoot);
  let done = false;
  try {
    await runWithCleanup(
      async () => {
        const fixture = await TestServer.create({ runRoot, sessionName: "gate" });
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

describe("querying a field the server predates", () => {
  test("refuses it by name, and answers every field the server does have", async () => {
    await withServer(async (fixture) => {
      const server = serverFor(fixture);
      const snapshot = await server.snapshot();
      const raw = (await server.cmd("display-message", ["-p", "#{version}"], { target: null }))[0];
      expect(raw).toBeDefined();
      const running = parseTmuxVersion(raw ?? "");

      const available = WHERE_FIELDS_V1.pane.filter(
        (field) => compareTmuxVersions(running, parseTmuxVersion(field.since)) >= 0,
      );
      const tooNew = WHERE_FIELDS_V1.pane.filter(
        (field) => compareTmuxVersions(running, parseTmuxVersion(field.since)) < 0,
      );

      // A partition that put everything on one side would make half of this
      // vacuous, so the halves are asserted before they are used.
      expect(available.length).toBeGreaterThan(0);
      expect(available.length + tooNew.length).toBe(WHERE_FIELDS_V1.pane.length);
      expect(() => snapshot.sessions.where({ activeWindow: { is: null } }).count()).not.toThrow();

      for (const field of available) {
        expect(() =>
          snapshot.panes.where({ [field.criteriaName]: criterionFor(field.domain) }).count(),
        ).not.toThrow();
      }

      for (const field of tooNew) {
        const thrown = ((): unknown => {
          try {
            snapshot.panes
              .where({
                [field.criteriaName]: criterionFor(field.domain),
              })
              .count();
            return undefined;
          } catch (error) {
            return error;
          }
        })();
        expect(thrown).toBeInstanceOf(VersionTooLow);
        // Both versions, because "unsupported" without them leaves a caller
        // guessing which half to change.
        expect((thrown as VersionTooLow).message).toContain(field.since);
        expect((thrown as VersionTooLow).message).toContain(raw ?? "");
        expect((thrown as VersionTooLow).criteriaName).toBe(field.criteriaName);
      }
    });
  }, 40_000);
});
