import { describe, expect, test } from "bun:test";

import { GuardCodec } from "../../src/_internal/codec/guard_codec.js";
import { ACQUISITION_LISTINGS } from "../../src/_internal/operations/acquire.js";
import { deriveTmuxCapabilities } from "../../src/_internal/runtime/capabilities.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import { prepareInvocationRequest } from "../../src/_internal/operations/request.js";
import {
  flattenInvocation,
  MAX_PACKED_ARGV_BYTES,
  packedArgvBytes,
} from "../../src/_internal/transport/invocation.js";
import { SUPPORTED_TMUX_VERSIONS } from "../support/tmux_matrix.js";
import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";

/**
 * Room to grow before tmux refuses the acquisition outright.
 *
 * A new tmux release adds format fields, and each one costs its token plus a
 * separator in all four listings. This margin is what turns "the next release
 * broke `snapshot()` at runtime" into a red test at the moment the registry is
 * regenerated for it.
 */
const REQUIRED_HEADROOM_BYTES = 3072;

function acquisitionArgv(rawVersion: string): readonly string[] {
  const capabilities = deriveTmuxCapabilities({
    connectionAlias: "budget" as ConnectionAlias,
    daemonEpoch: 0 as DaemonEpoch,
    rawVersion,
  });
  const connection = new TmuxConnection({
    executable: "/usr/bin/tmux",
    // The longest socket path the suite's own harness produces, so the budget
    // is measured against a real one and not against a default.
    socketPath: "/tmp/ltx-0123456789abcdef-0123456789abcdef/s",
  });
  const commands = ACQUISITION_LISTINGS.map((listing) => {
    const request = new GuardCodec({
      capabilities,
      listCommand: listing.listCommand,
    }).prepare();
    return [listing.listCommand, ...(listing.listExtraArgs ?? []), `-F${request.format}`];
  });
  return flattenInvocation(prepareInvocationRequest(connection, commands));
}

describe("acquisition argv budget", () => {
  test("one atomic acquisition fits what tmux packs an argv into, with room to grow", () => {
    const measured = SUPPORTED_TMUX_VERSIONS.map((version) => {
      const packed = packedArgvBytes(["/usr/bin/tmux", ...acquisitionArgv(version)]);
      return { fits: packed <= MAX_PACKED_ARGV_BYTES - REQUIRED_HEADROOM_BYTES, packed, version };
    });

    // Asserted as one object so a failure prints every version's size: the
    // number is the first thing whoever regenerated the registry needs, and the
    // two ways out are narrowing each listing's scopes or shortening the
    // record guards.
    expect(measured.filter((entry) => !entry.fits)).toEqual([]);
  });

  test("the field separator is one byte, because 569 of them are what decides the budget", () => {
    const capabilities = deriveTmuxCapabilities({
      connectionAlias: "budget" as ConnectionAlias,
      daemonEpoch: 0 as DaemonEpoch,
      rawVersion: "3.7b",
    });
    const request = new GuardCodec({ capabilities, listCommand: "list-panes" }).prepare();
    expect(request.guards.field).toHaveLength(1);
    expect(request.format).toContain(`#{q:pane_id}${request.guards.field}`);
  });
});
