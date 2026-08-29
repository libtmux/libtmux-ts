import { describe, expect, test } from "bun:test";
import { FORMAT_FIELD_TOKENS } from "../../src/_generated/format_fields.js";

import {
  executeGuardedListGroup,
  FormatProtocolError,
  GuardCodec,
  type FormatGuards,
  type GuardedFormatRequest,
} from "../../src/_internal/codec/guard_codec.js";
import { deriveTmuxCapabilities } from "../../src/_internal/runtime/capabilities.js";
import { TmuxConnection } from "../../src/_internal/runtime/connection.js";
import type { ConnectionAlias, DaemonEpoch } from "../../src/common.js";
import { LibTmuxException } from "../../src/exc.js";

const encoder = new TextEncoder();
const guards: FormatGuards = Object.freeze({
  field: ";",
  recordEnd: "ltxE6c22",
  recordStart: "ltxSa913",
});

/** What `format_quote_shell` does, so a fixture frames the way tmux does. */
function quoteAsTmuxDoes(value: string): string {
  return value.replaceAll(/[|&;<>()$`\\"'*?[# =%]/gu, (character) => `\\${character}`);
}

function valueFor(token: string, overrides: Readonly<Record<string, string>>): string {
  if (Object.hasOwn(overrides, token)) return overrides[token]!;
  if (token === "session_id") return "$7";
  if (token === "window_id") return "@8";
  if (token === "pane_id") return "%9";
  if (token === "next_session_id") return "$10";
  if (token === "client_name") return "/dev/pts/42";
  return `value:${token}`;
}

function frame(
  request: GuardedFormatRequest,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const values = request.fields.map(({ token }) => quoteAsTmuxDoes(valueFor(token, overrides)));
  return `${request.guards.recordStart}${values.join(request.guards.field)}${request.guards.recordEnd}`;
}

function codecFor(
  listCommand: "list-clients" | "list-panes" | "list-sessions" | "list-windows",
  version = "3.7b",
  guardFactory: () => FormatGuards = () => guards,
): GuardCodec {
  return new GuardCodec({
    capabilities: deriveTmuxCapabilities({
      connectionAlias: "codec-test" as ConnectionAlias,
      daemonEpoch: 1 as DaemonEpoch,
      rawVersion: version,
    }),
    guardFactory,
    listCommand,
  });
}

function replaceMarkerWithBytes(
  source: Uint8Array,
  marker: string,
  replacement: Uint8Array,
): Uint8Array {
  const needle = encoder.encode(marker);
  const index = Buffer.from(source).indexOf(needle);
  if (index < 0) throw new Error("byte marker is absent");
  const result = new Uint8Array(source.length - needle.length + replacement.length);
  result.set(source.slice(0, index), 0);
  result.set(replacement, index);
  result.set(source.slice(index + needle.length), index + replacement.length);
  return result;
}

describe("guarded format codec", () => {
  test("does not invent a failing subcommand for one aggregate result", async () => {
    const capabilities = deriveTmuxCapabilities({
      connectionAlias: "codec-test" as ConnectionAlias,
      daemonEpoch: 1 as DaemonEpoch,
      rawVersion: "3.7b",
    });

    try {
      await executeGuardedListGroup({
        capabilities: { bind: () => Promise.resolve(capabilities) },
        connection: new TmuxConnection({ executable: "tmux" }),
        listings: [{ listCommand: "list-sessions" }, { listCommand: "list-windows" }],
        transport: {
          async execute() {
            return {
              cmd: ["tmux", "list-sessions", ";", "list-windows"],
              returncode: 1,
              signal: null,
              stderr: encoder.encode("one command failed\n"),
              stdout: new Uint8Array(),
            };
          },
        },
      });
      throw new Error("expected the command list to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LibTmuxException);
      if (!(error instanceof LibTmuxException)) throw error;
      expect(error.message).toBe("one command failed");
      expect(error.subcommand).toBeUndefined();
    }
  });

  test("prepares one request-bound format without a fixed separator or newline boundary", () => {
    const request = codecFor("list-sessions").prepare();

    expect(request.format).toBe(
      `${guards.recordStart}${request.fields.map(({ token }) => `#{q:${token}}`).join(guards.field)}${guards.recordEnd}`,
    );
    expect(request.format).not.toContain("␞");
    expect(request.format).not.toContain("\n");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.fields)).toBe(true);
    expect(Object.isFrozen(request.guards)).toBe(true);
    expect(request.capabilityFingerprint).toBe(
      deriveTmuxCapabilities({
        connectionAlias: "codec-test" as ConnectionAlias,
        daemonEpoch: 1 as DaemonEpoch,
        rawVersion: "3.7b",
      }).fingerprint,
    );
    expect(request.tmuxVersion.raw).toBe("3.7b");
  });

  test("rejects invalid injected guards before constructing a request", () => {
    const duplicate = Object.freeze({
      field: "DUPLICATE",
      recordEnd: "END",
      recordStart: "DUPLICATE",
    });
    expect(() => codecFor("list-sessions", "3.7b", () => duplicate).prepare()).toThrow(
      FormatProtocolError,
    );

    for (const key of ["field", "recordEnd", "recordStart"] as const) {
      for (const invalid of ["", "line\nbreak", "雪"]) {
        const candidate = Object.freeze({ ...guards, [key]: invalid });
        expect(() => codecFor("list-sessions", "3.7b", () => candidate).prepare()).toThrow(
          FormatProtocolError,
        );
      }
    }
  });

  test("rejects a request prepared by another codec with identical capabilities and guards", () => {
    const firstCodec = codecFor("list-sessions");
    const secondCodec = codecFor("list-sessions");
    const foreignRequest = firstCodec.prepare();
    const ownRequest = secondCodec.prepare();
    const foreignBytes = encoder.encode(`${frame(foreignRequest)}\n`);

    expect(foreignRequest.capabilityFingerprint).toBe(ownRequest.capabilityFingerprint);
    expect(foreignRequest.guards).toEqual(ownRequest.guards);
    expect(() => secondCodec.decode(foreignRequest, foreignBytes)).toThrow(FormatProtocolError);
    expect(() => secondCodec.decode(foreignRequest, foreignBytes)).toThrow(
      "foreign GuardedFormatRequest",
    );
    expect(() =>
      secondCodec.decode(ownRequest, encoder.encode(`${frame(ownRequest)}\n`)),
    ).not.toThrow();
  });

  test("binds preparation to version, connection alias, and daemon epoch", () => {
    const prepared = [
      { alias: "a", epoch: 1, version: "3.7b" },
      { alias: "b", epoch: 1, version: "3.7b" },
      { alias: "a", epoch: 2, version: "3.7b" },
      { alias: "a", epoch: 1, version: "3.7a" },
    ].map(({ alias, epoch, version }) =>
      new GuardCodec({
        capabilities: deriveTmuxCapabilities({
          connectionAlias: alias as ConnectionAlias,
          daemonEpoch: epoch as DaemonEpoch,
          rawVersion: version,
        }),
        guardFactory: () => guards,
        listCommand: "list-sessions",
      }).prepare(),
    );

    expect(new Set(prepared.map(({ capabilityFingerprint }) => capabilityFingerprint)).size).toBe(
      4,
    );
  });

  test("preserves empty, legacy-separator, and embedded-newline values", () => {
    const codec = codecFor("list-sessions", "3.2a");
    const request = codec.prepare();
    const bytes = encoder.encode(
      `${frame(request, {
        session_group: "",
        session_name: "alpha␞beta\nsecond line",
      })}\n`,
    );

    const rows = codec.decode(request, bytes);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_name).toBe("alpha␞beta\nsecond line");
    expect(rows[0]?.session_group).toBe("");
    expect(rows[0]?.pane_x).toBeNull();
    expect(rows[0]?.client_name).toBeNull();
    // Every field the registry knows, derived rather than pinned: the
    // vocabulary grows when tmux does, and a literal here would have to be
    // edited each time without saying why.
    expect(Object.keys(rows[0] ?? {})).toHaveLength(FORMAT_FIELD_TOKENS.length);
  });

  test("decodes multiple complete frames without splitting data on newline", () => {
    const codec = codecFor("list-windows");
    const request = codec.prepare();
    const bytes = encoder.encode(
      `${frame(request, { window_id: "@1", window_name: "first\nwindow" })}\n${frame(request, {
        window_id: "@2",
        window_name: "second",
      })}\n`,
    );

    const rows = codec.decode(request, bytes);

    expect(rows.map(({ window_id, window_name }) => ({ window_id, window_name }))).toEqual([
      { window_id: "@1", window_name: "first\nwindow" },
      { window_id: "@2", window_name: "second" },
    ]);
  });

  test("accepts a non-sigil client name as the list-clients identity", () => {
    const codec = codecFor("list-clients");
    const request = codec.prepare();

    for (const clientName of ["/dev/pts/91", "client-control-1"]) {
      const rows = codec.decode(
        request,
        encoder.encode(`${frame(request, { client_name: clientName })}\n`),
      );
      expect(rows[0]?.client_name).toBe(clientName);
    }
  });

  test("applies Python-compatible per-byte replacement inside a valid field", () => {
    const codec = codecFor("list-sessions");
    const request = codec.prepare();
    const encoded = encoder.encode(
      `${frame(request, { session_name: "LIBTMUX_INVALID_BYTE_MARKER" })}\n`,
    );
    const withInvalidByte = replaceMarkerWithBytes(
      encoded,
      "LIBTMUX_INVALID_BYTE_MARKER",
      Uint8Array.of(0x61, 0xff, 0x62),
    );

    expect(codec.decode(request, withInvalidByte)[0]?.session_name).toBe("a\\xffb");
  });

  test("rejects wrong field counts before row validation", () => {
    const codec = codecFor("list-panes");
    const request = codec.prepare();
    const values = request.fields.slice(0, -1).map(({ token }) => valueFor(token, {}));
    const malformed = `${request.guards.recordStart}${values.join(request.guards.field)}${request.guards.recordEnd}\n`;

    expect(() => codec.decode(request, encoder.encode(malformed))).toThrow(
      "guarded frame has the wrong field count",
    );
  });

  test("rejects malformed primary identities for every list kind", () => {
    const cases = [
      ["list-sessions", { session_id: "@1" }],
      ["list-windows", { window_id: "$1" }],
      ["list-panes", { pane_id: "@1" }],
      ["list-clients", { client_name: "" }],
      ["list-clients", { client_name: "$1" }],
      ["list-clients", { client_name: "@1" }],
      ["list-clients", { client_name: "%1" }],
    ] as const;

    for (const [listCommand, override] of cases) {
      const codec = codecFor(listCommand);
      const request = codec.prepare();
      expect(() => codec.decode(request, encoder.encode(`${frame(request, override)}\n`))).toThrow(
        FormatProtocolError,
      );
    }
  });

  test("rejects a malformed populated identity outside the primary key", () => {
    const codec = codecFor("list-sessions");
    const request = codec.prepare();

    expect(() =>
      codec.decode(request, encoder.encode(`${frame(request, { next_session_id: "@1" })}\n`)),
    ).toThrow(FormatProtocolError);
  });

  test("detects literal unknown format tokens", () => {
    const codec = codecFor("list-sessions");
    const request = codec.prepare();

    for (const literal of ["#{session_name}", "#{libtmux_unknown}"]) {
      expect(() =>
        codec.decode(request, encoder.encode(`${frame(request, { session_name: literal })}\n`)),
      ).toThrow("tmux returned a literal unknown format token");
    }
  });

  test("rejects incomplete, ambiguous, trailing, and invalid UTF-8 frames", () => {
    const codec = codecFor("list-sessions");
    const request = codec.prepare();
    const valid = frame(request);
    const invalid = [
      encoder.encode(valid.slice(0, -5)),
      encoder.encode(`${valid}\ntrailing`),
      encoder.encode(`${frame(request, { session_name: `before${guards.recordStart}after` })}\n`),
      encoder.encode(`${frame(request, { session_name: `before${guards.recordEnd}after` })}\n`),
      Uint8Array.of(0xff),
    ];

    for (const bytes of invalid) {
      expect(() => codec.decode(request, bytes)).toThrow(FormatProtocolError);
    }
  });

  test("reads an escaped separator as data and an unescaped one as a framing failure", () => {
    let guardCalls = 0;
    const codec = codecFor("list-sessions", "3.7b", () => {
      guardCalls += 1;
      return guards;
    });
    const request = codec.prepare();

    // tmux escapes the separator inside a value, so a name holding one is a
    // name and not an ambiguity — this is what quoting buys over a guard.
    const carried = `a${guards.field}b\\c`;
    const [row] = codec.decode(
      request,
      encoder.encode(`${frame(request, { session_name: carried })}\n`),
    );
    expect(row?.session_name).toBe(carried);

    // One that arrives unescaped can only be tmux having stopped quoting, and
    // that has to fail the frame rather than silently cut a value in two.
    expect(() =>
      codec.decode(
        request,
        encoder.encode(
          `${guards.recordStart}${request.fields.map(() => "x").join(guards.field)}${guards.field}x${guards.recordEnd}\n`,
        ),
      ),
    ).toThrow(FormatProtocolError);
    expect(guardCalls).toBe(1);
  });

  test("wraps schema failures without exposing Zod errors", () => {
    const codec = codecFor("list-sessions");
    const request = codec.prepare();

    try {
      codec.decode(request, encoder.encode(`${frame(request, { session_id: "invalid" })}\n`));
      throw new Error("expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FormatProtocolError);
      expect(error).toBeInstanceOf(LibTmuxException);
      expect((error as Error).name).toBe("FormatProtocolError");
      expect((error as Error).constructor.name).not.toBe("ZodError");
    }
  });
});
