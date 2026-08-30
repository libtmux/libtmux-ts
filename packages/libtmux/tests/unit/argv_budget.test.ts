import { describe, expect, test } from "bun:test";

import { GuardCodec } from "../../src/_internal/codec/guard_codec.js";
import { executeGuardedListGroup } from "../../src/_internal/codec/guarded_listing.js";
import { ACQUISITION_LISTINGS } from "../../src/_internal/operations/acquire.js";
import { deriveTmuxCapabilities } from "../../src/_internal/runtime/capabilities.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { prepareInvocationRequest } from "../../src/_internal/operations/request.js";
import {
  MAX_PACKED_ARGV_BYTES,
  MAX_PACKED_ARGV_COUNT,
  packedCommandBytes,
  packedCommandCount,
} from "../../src/_internal/transport/invocation.js";
import { SUPPORTED_TMUX_VERSIONS } from "../support/tmux_matrix.js";
import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";
import type { CommandRequest } from "../../src/_internal/transport/types.js";

/**
 * Room to grow before tmux refuses the acquisition outright.
 *
 * A new tmux release adds format fields, and each one costs its token plus a
 * separator in all four listings. This margin is what turns "the next release
 * broke `snapshot()` at runtime" into a red test at the moment the registry is
 * regenerated for it.
 */
const REQUIRED_HEADROOM_BYTES = 3072;

async function acquisitionRequest(rawVersion: string): Promise<CommandRequest> {
  const capabilities = deriveTmuxCapabilities({
    connectionAlias: "budget" as ConnectionAlias,
    daemon: { pid: "101", startTime: "202" },
    daemonEpoch: 0 as DaemonEpoch,
    rawVersion,
  });
  const connection = new TmuxConnection({
    executable: "/usr/bin/tmux",
    // The longest socket path the suite's own harness produces, so the budget
    // is measured against a real one and not against a default.
    socketPath: "/tmp/ltx-0123456789abcdef-0123456789abcdef/s",
  });
  let captured: CommandRequest | undefined;
  await executeGuardedListGroup({
    capabilities: { bind: () => Promise.resolve(capabilities) },
    connection,
    listings: ACQUISITION_LISTINGS,
    transport: {
      execute(request) {
        captured = request;
        return Promise.resolve({
          cmd: ["tmux"],
          returncode: 0,
          signal: null,
          stderr: new Uint8Array(),
          stdout: new TextEncoder().encode("ltxI101;202\n"),
        });
      },
    },
  });
  if (captured === undefined) throw new Error("acquisition did not execute");
  return captured;
}

describe("acquisition argv budget", () => {
  test("one atomic acquisition fits what tmux packs an argv into, with room to grow", async () => {
    const measured = await Promise.all(
      SUPPORTED_TMUX_VERSIONS.map(async (version) => {
        const packed = packedCommandBytes(await acquisitionRequest(version));
        return { fits: packed <= MAX_PACKED_ARGV_BYTES - REQUIRED_HEADROOM_BYTES, packed, version };
      }),
    );

    // Asserted as one object so a failure prints every version's size: the
    // number is the first thing whoever regenerated the registry needs, and the
    // two ways out are narrowing each listing's scopes or shortening the
    // record guards.
    expect(measured.filter((entry) => !entry.fits)).toEqual([]);
  });

  test("the field separator is one byte, because 569 of them are what decides the budget", () => {
    const capabilities = deriveTmuxCapabilities({
      connectionAlias: "budget" as ConnectionAlias,
      daemon: { pid: "101", startTime: "202" },
      daemonEpoch: 0 as DaemonEpoch,
      rawVersion: "3.7b",
    });
    const request = new GuardCodec({ capabilities, listCommand: "list-panes" }).prepare();
    expect(request.guards.field).toHaveLength(1);
    expect(request.format).toContain(`#{q:pane_id}${request.guards.field}`);
  });

  test("charges what tmux packs, which is neither the executable nor the global flags", () => {
    const near = new TmuxConnection({ executable: "/usr/bin/tmux", socketPath: "/tmp/ltx-a/s" });
    const far = new TmuxConnection({
      executable: "/a/much/longer/path/to/tmux",
      socketPath: "/tmp/ltx-a-deliberately-much-longer-socket-directory/s",
    });
    const command = [["display-message", "-p", "x".repeat(64)]];
    // tmux parses its own global flags and packs only the command, so neither
    // the executable nor `-S` may consume a caller's budget.
    expect(packedCommandBytes(prepareInvocationRequest(far, command))).toBe(
      packedCommandBytes(prepareInvocationRequest(near, command)),
    );
    // Measured against real servers: a packed command of 16364 bytes is
    // accepted by 3.2a and 3.7c alike, and 16365 fails.
    expect(MAX_PACKED_ARGV_BYTES).toBe(16_364);
  });

  test("counts arguments too, because tmux refuses on either bound", () => {
    const connection = new TmuxConnection({
      executable: "/usr/bin/tmux",
      socketPath: "/tmp/ltx-a/s",
    });
    // 250 commands of three arguments, plus the 249 separators between them.
    const many = Array.from({ length: 250 }, () => ["display-message", "-p", "x"]);
    const request = prepareInvocationRequest(connection, many);
    expect(packedCommandCount(request)).toBe(999);
    // Measured: tmux parses 1000 packed arguments and refuses 1001 as
    // `command too long`, whatever the byte size — 999 of these are 6KB.
    expect(MAX_PACKED_ARGV_COUNT).toBe(1000);
    expect(packedCommandBytes(request)).toBeLessThan(MAX_PACKED_ARGV_BYTES);
  });
});
