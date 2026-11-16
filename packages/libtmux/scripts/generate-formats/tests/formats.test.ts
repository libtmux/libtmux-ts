import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { generateFormats } from "../generate-formats.js";
import { releaseAtLeast } from "../../../src/_internal/runtime/tmux_version.js";
import { MINIMUM_TMUX } from "../../../src/_internal/support/versions.js";
import type { FormatFieldName, FormatScope } from "../../../src/_generated/format_field_names.js";
import { FORMAT_FIELD_TOKENS } from "../../../src/_generated/format_fields.js";
import { WHERE_ALIASES_V1, WHERE_FIELDS_V1 } from "../../../src/_generated/where_fields.js";
import {
  FORMAT_REGISTRY,
  formatFieldsForListCommand,
  lookupFormatField,
  renderGeneratedFormatSources,
  validateWhereSchemaHistory,
} from "../../../src/_internal/codec/format_registry.js";

import { makeTestDirectory } from "../../../src/_internal/test/testkit.js";

interface FormatFixture {
  fields: Array<{ scope: FormatScope; since: string; token: FormatFieldName }>;
}

const fieldUrl = new URL("../../../tests/fixtures/tmux-format-fields.json", import.meta.url);
const tsRootPath = fileURLToPath(new URL("../../..", import.meta.url));

async function readFields(): Promise<FormatFixture["fields"]> {
  return (JSON.parse(await readFile(fieldUrl, "utf8")) as FormatFixture).fields;
}

async function runBoundedCommand(
  command: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const child = Bun.spawn([...command], {
    ...options,
    stderr: "pipe",
    stdout: "pipe",
  });
  let deadlineReached = false;
  const terminate = setTimeout(() => {
    deadlineReached = true;
    child.kill("SIGTERM");
  }, 5_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 5_500);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (deadlineReached) throw new Error(`subprocess exceeded deadline: ${command.join(" ")}`);
    return { exitCode, stderr, stdout };
  } finally {
    clearTimeout(terminate);
    clearTimeout(kill);
  }
}

function runGeneratorCli(arguments_: readonly string[], cwd = tsRootPath) {
  return runBoundedCommand(["bun", "scripts/generate-formats/generate-formats.ts", ...arguments_], {
    cwd,
  });
}

describe("format registry", () => {
  test("matches every fixture token, scope, and version floor", async () => {
    const fields = await readFields();
    // A floor below the supported minimum is the minimum: no daemon this
    // package drives lacks the field.
    const atFloor = <Field extends { since: string }>(field: Field): Field => ({
      ...field,
      since: releaseAtLeast(field.since, MINIMUM_TMUX) ? field.since : MINIMUM_TMUX,
    });
    const registry = FORMAT_REGISTRY.map(({ scope, since, token }) => ({
      scope,
      since: since.raw,
      token,
    }));

    expect(registry.toSorted((left, right) => (left.token < right.token ? -1 : 1))).toEqual(
      fields.map(atFloor).toSorted((left, right) => (left.token < right.token ? -1 : 1)),
    );
    expect(new Set(FORMAT_REGISTRY.map(({ token }) => token)).size).toBe(fields.length);
    expect(Object.isFrozen(FORMAT_REGISTRY)).toBe(true);
    expect(Object.isFrozen(FORMAT_FIELD_TOKENS)).toBe(true);
    for (const field of FORMAT_REGISTRY) {
      expect(Object.keys(field).sort(), field.token).toEqual([
        "criteriaWireNames",
        "rawRepresentation",
        "scalarFilterDomain",
        "scope",
        "since",
        "snapshotDestination",
        "token",
      ]);
      expect(Object.isFrozen(field), field.token).toBe(true);
      expect(Object.isFrozen(field.criteriaWireNames), field.token).toBe(true);
      expect(Object.isFrozen(field.since), field.token).toBe(true);
    }
    for (const { token } of fields) {
      expect(FORMAT_FIELD_TOKENS, token).toContain(token);
    }
  });

  test("resolves every fixture token while unknown tokens fail closed", async () => {
    const fields = await readFields();
    const byToken = new Map(FORMAT_REGISTRY.map((field) => [field.token, field]));

    expect(FORMAT_REGISTRY).toHaveLength(fields.length);
    for (const { token } of fields) {
      const resolved = lookupFormatField(token);
      expect(resolved, token).toBeDefined();
      expect(resolved?.token, token).toBe(token);
      expect(resolved, token).toBe(byToken.get(token));
    }
    expect(lookupFormatField("libtmux_nonexistent_format_token")).toBeUndefined();
  });

  test("keeps raw, snapshot, and criteria destinations explicit", () => {
    expect(FORMAT_REGISTRY.every(({ rawRepresentation }) => rawRepresentation === "string")).toBe(
      true,
    );

    const destinationCases = [
      ["config_files", "server"],
      ["session_name", "session"],
      ["window_name", "window"],
      ["pane_id", "pane"],
      ["client_name", "client"],
      ["line", "raw-row"],
    ] as const;
    for (const [token, destination] of destinationCases) {
      expect(FORMAT_REGISTRY.find((field) => field.token === token)?.snapshotDestination).toBe(
        destination,
      );
    }

    const winlinkFields = [
      "window_active",
      "window_activity_flag",
      "window_bell_flag",
      "window_end_flag",
      "window_flags",
      "window_index",
      "window_last_flag",
      "window_marked_flag",
      "window_raw_flags",
      "window_silence_flag",
      "window_stack_index",
      "window_start_flag",
    ];
    const winlinkFieldSet = new Set(winlinkFields);
    for (const token of winlinkFields) {
      expect(FORMAT_REGISTRY.find((field) => field.token === token)?.snapshotDestination).toBe(
        "winlink",
      );
    }

    const rawRowWindowFields = [
      "window_bigger",
      "window_format",
      "window_offset_x",
      "window_offset_y",
    ];
    const rawRowWindowFieldSet = new Set(rawRowWindowFields);
    for (const token of rawRowWindowFields) {
      expect(FORMAT_REGISTRY.find((field) => field.token === token)?.snapshotDestination).toBe(
        "raw-row",
      );
    }

    for (const field of FORMAT_REGISTRY.filter(({ scope }) =>
      ["buffer", "context", "event"].includes(scope),
    )) {
      expect(field.snapshotDestination, field.token).toBe("raw-row");
    }

    for (const field of FORMAT_REGISTRY) {
      const expectedDestination = winlinkFieldSet.has(field.token)
        ? "winlink"
        : rawRowWindowFieldSet.has(field.token) ||
            field.token === "line" ||
            ["buffer", "context", "event"].includes(field.scope)
          ? "raw-row"
          : field.scope === "universal"
            ? "server"
            : field.scope === "client" ||
                field.scope === "pane" ||
                field.scope === "session" ||
                field.scope === "window"
              ? field.scope
              : "raw-row";
      expect(field.snapshotDestination, field.token).toBe(expectedDestination);
    }

    expect(new Set(FORMAT_REGISTRY.map(({ snapshotDestination }) => snapshotDestination))).toEqual(
      new Set(["server", "session", "window", "winlink", "pane", "client", "raw-row"]),
    );

    expect(FORMAT_REGISTRY.find(({ token }) => token === "session_name")).toMatchObject({
      criteriaWireNames: { session: "name" },
      scalarFilterDomain: "string",
    });
    expect(FORMAT_REGISTRY.find(({ token }) => token === "window_name")).toMatchObject({
      criteriaWireNames: { window: "name" },
      scalarFilterDomain: "string",
    });
    expect(FORMAT_REGISTRY.find(({ token }) => token === "pane_id")).toMatchObject({
      criteriaWireNames: { pane: "pane_id" },
      scalarFilterDomain: "string",
    });
    // Universal-scope fields carry one value per server, so they are readable
    // on a handle but are never criteria.
    expect(FORMAT_REGISTRY.find(({ token }) => token === "pid")).toMatchObject({
      criteriaWireNames: {},
      scalarFilterDomain: null,
    });
    // `client_name` is client-scope, so it is a criteria field of the client
    // model and of no other — unlike `pid`, which is universal and is criteria
    // for nobody.
    expect(FORMAT_REGISTRY.find(({ token }) => token === "client_name")).toMatchObject({
      criteriaWireNames: { client: "client_name" },
      scalarFilterDomain: "string",
    });
  });

  test("selects list scopes while carrying version floors", () => {
    // Every release the package supports: 3.4, 3.5 and 3.6 each gain fields,
    // so a run that skipped them would not prove the gating.
    const expectedCounts = {
      "3.3a": { clients: 152, panes: 127, sessions: 127, windows: 127 },
      "3.4": { clients: 153, panes: 128, sessions: 128, windows: 128 },
      "3.5": { clients: 154, panes: 129, sessions: 129, windows: 129 },
      "3.6": { clients: 163, panes: 138, sessions: 138, windows: 138 },
      "3.7": { clients: 174, panes: 149, sessions: 149, windows: 149 },
      "3.7a": { clients: 174, panes: 149, sessions: 149, windows: 149 },
      "3.7b": { clients: 174, panes: 149, sessions: 149, windows: 149 },
    };

    for (const [version, counts] of Object.entries(expectedCounts)) {
      expect(formatFieldsForListCommand("list-sessions", version)).toHaveLength(counts.sessions);
      expect(formatFieldsForListCommand("list-windows", version)).toHaveLength(counts.windows);
      expect(formatFieldsForListCommand("list-panes", version)).toHaveLength(counts.panes);
      expect(formatFieldsForListCommand("list-clients", version)).toHaveLength(counts.clients);
    }

    const clientScopes = new Set(
      formatFieldsForListCommand("list-clients", "3.7b").map(({ scope }) => scope),
    );
    expect(clientScopes).toEqual(new Set(["client", "pane", "session", "universal", "window"]));
    const ordinaryScopes = new Set(
      formatFieldsForListCommand("list-sessions", "3.7b").map(({ scope }) => scope),
    );
    expect(ordinaryScopes).toEqual(new Set(["pane", "session", "universal", "window"]));

    for (const masterVersion of ["next-3.9", "next-3.8"]) {
      expect(
        formatFieldsForListCommand("list-panes", masterVersion).some(
          ({ token }) => token === "pane_x",
        ),
      ).toBe(true);
    }
  });

  test("generates only canonical scalar Where fields for eligible models", () => {
    expect(Object.isFrozen(WHERE_FIELDS_V1)).toBe(true);
    expect(Object.isFrozen(WHERE_ALIASES_V1)).toBe(true);
    for (const fields of Object.values(WHERE_FIELDS_V1)) {
      expect(Object.isFrozen(fields)).toBe(true);
      expect(fields.every((field) => Object.isFrozen(field))).toBe(true);
    }
    for (const aliases of Object.values(WHERE_ALIASES_V1)) {
      expect(Object.isFrozen(aliases)).toBe(true);
    }
    expect(Object.keys(WHERE_FIELDS_V1)).toEqual(["session", "window", "pane", "client"]);
    expect(WHERE_FIELDS_V1.session).toHaveLength(28);
    expect(WHERE_FIELDS_V1.window).toHaveLength(34);
    expect(WHERE_FIELDS_V1.pane).toHaveLength(78);
    expect(createHash("sha256").update(JSON.stringify(WHERE_FIELDS_V1.session)).digest("hex")).toBe(
      "c472f06a23d1c68f2982e144b9b575877a99ee4fd011254d9530f150d1c01e66",
    );
    expect(createHash("sha256").update(JSON.stringify(WHERE_FIELDS_V1.window)).digest("hex")).toBe(
      "5eed55c1ae15fbba89155a160d48bfa34c1fd99294ad92f427bf57b2e9de753c",
    );
    expect(createHash("sha256").update(JSON.stringify(WHERE_FIELDS_V1.pane)).digest("hex")).toBe(
      "302ebeff8004fb53e81003381092e2d568f2bfa15d704607d15a78723f19c4bf",
    );
    expect(createHash("sha256").update(JSON.stringify(WHERE_FIELDS_V1.client)).digest("hex")).toBe(
      "723af8f38c53e30652960f6c35ebc807ec0a84c333a592a4018f5589357c33c2",
    );
    for (const [model, fields] of Object.entries(WHERE_FIELDS_V1)) {
      for (const field of fields) {
        expect(
          FORMAT_REGISTRY.find(({ token }) => token === field.token)?.criteriaWireNames[
            model as "client" | "pane" | "session" | "window"
          ],
        ).toBe(field.wireName);
      }
    }
    expect(WHERE_FIELDS_V1.session.some(({ wireName }) => wireName === "name")).toBe(true);
    expect(WHERE_FIELDS_V1.window.some(({ wireName }) => wireName === "name")).toBe(true);
    expect(WHERE_FIELDS_V1.pane.some(({ wireName }) => wireName === "name")).toBe(false);
    // A client's own fields belong to the client model and to nothing else:
    // `client_name` is how tmux identifies a client, and a session filtered by
    // it would be filtering on a column its rows do not have.
    expect(WHERE_FIELDS_V1.client.some(({ token }) => token === "client_name")).toBe(true);
    for (const model of ["session", "window", "pane"] as const) {
      expect(WHERE_FIELDS_V1[model].some(({ token }) => token.startsWith("client_"))).toBe(false);
    }
    expect(JSON.stringify(WHERE_FIELDS_V1)).not.toContain("refresh");
  });

  test("keeps schema version 1 alias-free and validates future alias provenance", () => {
    expect(WHERE_ALIASES_V1).toEqual({ client: {}, pane: {}, session: {}, window: {} });

    expect(() =>
      validateWhereSchemaHistory([
        {
          aliases: { client: {}, pane: {}, session: {}, window: {} },
          fields: { client: [], pane: ["pane_id"], session: ["name"], window: ["name"] },
          version: 1,
        },
        {
          aliases: { client: {}, pane: {}, session: { name: "label" }, window: {} },
          fields: { client: [], pane: ["pane_id"], session: ["label"], window: ["name"] },
          version: 2,
        },
      ]),
    ).not.toThrow();

    expect(() =>
      validateWhereSchemaHistory([
        {
          aliases: { client: {}, pane: {}, session: {}, window: {} },
          fields: { client: [], pane: ["pane_id"], session: ["name"], window: ["name"] },
          version: 1,
        },
        {
          aliases: { client: {}, pane: {}, session: { neverShipped: "name" }, window: {} },
          fields: { client: [], pane: ["pane_id"], session: ["name"], window: ["name"] },
          version: 2,
        },
      ]),
    ).toThrow("alias must name a field from an earlier schema");

    expect(() =>
      validateWhereSchemaHistory([
        {
          aliases: { client: {}, pane: {}, session: { oldName: "name" }, window: {} },
          fields: { client: [], pane: ["pane_id"], session: ["name"], window: ["name"] },
          version: 1,
        },
      ]),
    ).toThrow("schema version 1 cannot contain aliases");
  });

  test("renders deterministic generated sources", () => {
    const first = renderGeneratedFormatSources();
    const second = renderGeneratedFormatSources();

    expect(first).toEqual(second);
    expect(Object.keys(first)).toEqual([
      "format_field_names.ts",
      "format_fields.ts",
      "where_fields.ts",
    ]);
    for (const source of Object.values(first)) expect(source.endsWith("\n")).toBe(true);
  });

  test("emits the field vocabulary without values so type-only importers stay light", () => {
    const sources = renderGeneratedFormatSources();
    const vocabulary = sources["format_field_names.ts"] ?? "";
    const table = sources["format_fields.ts"] ?? "";

    expect(vocabulary).toContain("export type FormatScope =");
    expect(vocabulary).toContain("export type FormatFieldName =");
    expect(vocabulary).toContain('  | "active_window_index"');
    expect(vocabulary).not.toContain("Object.freeze");
    expect(vocabulary).not.toContain("import");

    expect(table).toContain('from "./format_field_names.js"');
    expect(table).not.toContain("export type FormatFieldName =");
  });

  test("check mode detects exact-byte drift without rewriting it", async () => {
    const outputDirectory = await makeTestDirectory("ltx5-generated-");
    try {
      await generateFormats({ mode: "write", outputDirectory });
      await expect(generateFormats({ mode: "check", outputDirectory })).resolves.toBeUndefined();

      const generatedPath = join(outputDirectory, "format_fields.ts");
      const drifted = `${await readFile(generatedPath, "utf8")}drift\n`;
      await writeFile(generatedPath, drifted);

      await expect(generateFormats({ mode: "check", outputDirectory })).rejects.toThrow(
        "generated format outputs are out of date",
      );
      expect(await readFile(generatedPath, "utf8")).toBe(drifted);
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  test("CLI accepts exactly one explicit mode and rejected forms never write", async () => {
    const cliRoot = await mkdtemp(join(tsRootPath, ".task5-generator-cli-"));
    const generatedPaths = [
      join(cliRoot, "src/_generated/format_fields.ts"),
      join(cliRoot, "src/_generated/where_fields.ts"),
      join(cliRoot, "src/neo.ts"),
    ];
    const readGeneratedOutputs = () =>
      Promise.all(
        generatedPaths.map(async (path) => {
          try {
            return await readFile(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }),
      );
    try {
      await mkdir(join(cliRoot, "scripts/generate-formats"), { recursive: true });
      await Promise.all([
        cp(
          join(tsRootPath, "scripts/generate-formats/generate-formats.ts"),
          join(cliRoot, "scripts/generate-formats/generate-formats.ts"),
        ),
        cp(join(tsRootPath, "src"), join(cliRoot, "src"), { recursive: true }),
        cp(join(tsRootPath, "tests/fixtures"), join(cliRoot, "tests/fixtures"), {
          recursive: true,
        }),
        cp(join(tsRootPath, "package.json"), join(cliRoot, "package.json")),
      ]);
      const before = await readGeneratedOutputs();

      for (const arguments_ of [[], ["--unknown"], ["--check", "--write"]]) {
        // eslint-disable-next-line no-await-in-loop -- each rejected argv must settle before its immediate zero-write audit.
        const result = await runGeneratorCli(arguments_, cliRoot);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("usage: generate-formats.ts (--check|--write)");
        // eslint-disable-next-line no-await-in-loop -- later CLI cases must not repair an earlier rejected-mode write.
        expect(await readGeneratedOutputs()).toEqual(before);
      }

      const driftedFormatFields = Buffer.concat([
        before[0] ?? Buffer.alloc(0),
        Buffer.from("// generator CLI drift\n"),
      ]);
      await writeFile(generatedPaths[0]!, driftedFormatFields);
      const drifted = await readGeneratedOutputs();

      const check = await runGeneratorCli(["--check"], cliRoot);
      expect(check.exitCode).not.toBe(0);
      expect(check.stderr).toContain("generated format outputs are out of date");
      expect(await readGeneratedOutputs()).toEqual(drifted);

      await expect(runGeneratorCli(["--write"], cliRoot)).resolves.toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      const repaired = await readGeneratedOutputs();
      expect(repaired[0]).not.toEqual(drifted[0]);
      expect(repaired[0]).toEqual(before[0]);

      await expect(runGeneratorCli(["--check"], cliRoot)).resolves.toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(await readGeneratedOutputs()).toEqual(repaired);
    } finally {
      await rm(cliRoot, { force: true, recursive: true });
    }
  }, 40_000);
});
