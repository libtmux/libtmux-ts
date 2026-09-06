import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { v } from "../../src/_internal/validate.js";

/**
 * The in-house validator against Zod, on the same inputs.
 *
 * Zod is kept as a devDependency for exactly this: it has years of adversarial
 * use behind it and this validator has none, so the decision it reaches —
 * accept or reject — is the thing worth comparing. Messages differ by design
 * and are not compared.
 *
 * A disagreement here is a real defect either way round. Accepting something
 * Zod rejects lets malformed tmux output through into every handle built from
 * it; rejecting something Zod accepts breaks a caller for no reason.
 */

const ours = {
  clientName: v
    .string()
    .min(1)
    .refine((value) => !/^[%$@]/u.test(value), "a client name without a sigil"),
  document: v.discriminatedUnion(
    "model",
    [
      v.strictObject({
        model: v.literal("session"),
        version: v.literal(1),
        where: v.record(v.unknown()),
      }),
      v.strictObject({
        model: v.literal("pane"),
        version: v.literal(1),
        where: v.record(v.unknown()),
      }),
    ],
    ["session", "pane"],
  ),
  paneId: v.string().regex(/^%\d+$/u, "a pane id"),
  row: v.strictObject({ pane_id: v.string(), pane_title: v.string().nullable() }),
};

const theirs = {
  clientName: z
    .string()
    .min(1)
    .refine((value) => !/^[%$@]/u.test(value)),
  document: z.discriminatedUnion("model", [
    z.strictObject({
      model: z.literal("session"),
      version: z.literal(1),
      where: z.record(z.string(), z.unknown()),
    }),
    z.strictObject({
      model: z.literal("pane"),
      version: z.literal(1),
      where: z.record(z.string(), z.unknown()),
    }),
  ]),
  paneId: z.string().regex(/^%\d+$/u),
  row: z.strictObject({ pane_id: z.string(), pane_title: z.string().nullable() }),
};

/** Values that are awkward for any validator, independent of shape. */
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  " ",
  "%1",
  "%01",
  "%1 ",
  " %1",
  "%1\n",
  "%-1",
  "%",
  "$0",
  "@0",
  "﻿%1",
  "％1",
  "%１",
  "x".repeat(5_000),
  "\0",
  "😀",
  true,
  false,
  [],
  ["%1"],
  {},
  { pane_id: "%1" },
  Object.create(null) as object,
  new Date(0),
  Symbol.iterator,
  () => "%1",
  new Map(),
  JSON.parse('{"__proto__":{"x":1}}') as object,
];

const ROWS: readonly unknown[] = [
  { pane_id: "%1", pane_title: "t" },
  { pane_id: "%1", pane_title: null },
  { pane_id: "%1" },
  { pane_id: "%1", pane_title: undefined },
  { pane_id: "%1", pane_title: null, extra: 1 },
  { pane_id: null, pane_title: null },
  { pane_id: 1, pane_title: null },
  { pane_title: null },
  {},
  ...HOSTILE,
];

const DOCUMENTS: readonly unknown[] = [
  { model: "session", version: 1, where: {} },
  { model: "pane", version: 1, where: { name: "x" } },
  { model: "window", version: 1, where: {} },
  { model: "session", version: 2, where: {} },
  { model: "session", version: 1 },
  { model: "session", version: 1, where: {}, extra: 1 },
  { model: "session", version: 1, where: [] },
  { model: "session", version: 1, where: null },
  { model: 1, version: 1, where: {} },
  ...HOSTILE,
];

/** A deterministic pseudo-random string source; no Math.random in a gate. */
function* generated(count: number): Generator<string> {
  const alphabet = "%$@0123456789abc \n\0😀";
  let seed = 0x2f6e2b1;
  for (let index = 0; index < count; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    const length = seed % 8;
    let out = "";
    for (let position = 0; position < length; position += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      out += alphabet[seed % alphabet.length];
    }
    yield out;
  }
}

function agree(
  mine: { readonly success: boolean },
  zod: { readonly success: boolean },
  input: unknown,
  label: string,
): void {
  if (mine.success === zod.success) return;
  throw new Error(
    `${label}: ours=${String(mine.success)} zod=${String(zod.success)} for ${JSON.stringify(input) ?? String(input)}`,
  );
}

describe("validator agrees with Zod", () => {
  test("on strict rows, including missing, extra, and prototype keys", () => {
    for (const input of ROWS) {
      agree(ours.row.safeParse(input), theirs.row.safeParse(input), input, "row");
    }
  });

  test("on discriminated documents", () => {
    for (const input of DOCUMENTS) {
      agree(ours.document.safeParse(input), theirs.document.safeParse(input), input, "document");
    }
  });

  test("on pane ids, across hostile values", () => {
    for (const input of HOSTILE) {
      agree(ours.paneId.safeParse(input), theirs.paneId.safeParse(input), input, "paneId");
    }
  });

  test("on client names, where a length floor meets a refinement", () => {
    for (const input of HOSTILE) {
      agree(ours.clientName.safeParse(input), theirs.clientName.safeParse(input), input, "client");
    }
  });

  test("on two thousand generated strings", () => {
    for (const input of generated(2_000)) {
      agree(ours.paneId.safeParse(input), theirs.paneId.safeParse(input), input, "paneId");
      agree(ours.clientName.safeParse(input), theirs.clientName.safeParse(input), input, "client");
    }
  });

  test("reports a prototype key as unrecognized rather than dropping it", () => {
    // JSON.parse makes `__proto__` an own enumerable key, so it is an unknown
    // key by every definition Object.keys uses. Zod's strictObject accepted the
    // object through 4.4.3 and silently dropped the key, which is the one thing
    // a strict object must not do with something it does not recognise; 4.5.4
    // refuses it. Both validators are pinned here so a regression in either
    // side of the agreement fails rather than passing as a new consensus.
    const input = JSON.parse('{"pane_id":"%1","pane_title":null,"__proto__":{"z":1}}') as unknown;

    const zod = theirs.row.safeParse(input);
    expect(zod.success).toBe(false);
    if (zod.success) throw new Error("expected rejection");
    expect(zod.error.issues[0]).toMatchObject({ code: "unrecognized_keys" });

    const mine = ours.row.safeParse(input);
    expect(mine.success).toBe(false);
    if (mine.success) throw new Error("expected rejection");
    expect(mine.issues[0]).toMatchObject({ code: "unrecognized_keys" });
  });

  test("returns the same accepted value, not merely the same verdict", () => {
    const input = { pane_id: "%1", pane_title: null };
    const mine = ours.row.safeParse(input);
    const zod = theirs.row.safeParse(input);

    if (!mine.success || !zod.success) throw new Error("expected both to accept");
    expect({ ...mine.value }).toEqual({ ...zod.data });
  });
});
