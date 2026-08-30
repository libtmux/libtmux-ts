export type ParityKind =
  | "class"
  | "compatibility-alias"
  | "constant"
  | "enum-member"
  | "exception"
  | "format-field"
  | "function"
  | "method"
  | "property"
  | "root-export"
  | "test-helper";

export type Status = "planned" | "implemented" | "adapted" | "unsupported";
type EvidenceApplicability = "required" | `not-applicable: ${string}`;

export interface EvidenceApplicabilityFields {
  declarationTest: EvidenceApplicability;
  realTmuxScenario: EvidenceApplicability;
  unitTest: EvidenceApplicability;
}

export interface EvidenceFields {
  adaptation: string | null;
  declarationTest: string | null;
  evidenceApplicability: EvidenceApplicabilityFields;
  realTmuxScenario: string | null;
  reason: string | null;
  status: Status;
  typescript: string | null;
  typescriptSymbols: string[];
  unitTest: string | null;
}

export interface PublicSymbol extends EvidenceFields {
  kind: ParityKind;
  owner: string;
  python: string;
  source: string;
}

interface ObservableBehavior extends EvidenceFields {
  adaptation: string;
  id: string;
  owners: string[];
  pythonEvidence: string[];
}

interface TypeScriptExtension extends EvidenceFields {
  id: string;
  rationale: string;
  typescript: string;
}

interface InternalExclusion extends EvidenceFields {
  id: string;
  pythonEvidence: string[];
  reason: string;
}

export interface ParityManifest {
  baseline: {
    commit: string;
    pythonVersion: string;
    tag: string;
  };
  internalExclusions: InternalExclusion[];
  observableBehaviors: ObservableBehavior[];
  publicSymbols: PublicSymbol[];
  runtimeBoundary: {
    excludes: string[];
    includes: string;
  };
  schemaVersion: number;
  typescriptExtensions: TypeScriptExtension[];
}

/** The immutable Python release facts consumed by the parity gate. */
export interface ParityBaseline {
  generatedFrom: { commit: string; repository: string; tag: string };
  objects: Record<string, "blob" | "tree">;
  schemaVersion: number;
  symbols: Array<Pick<PublicSymbol, "kind" | "owner" | "python" | "source">>;
}

const evidenceKeys = [
  "adaptation",
  "declarationTest",
  "evidenceApplicability",
  "realTmuxScenario",
  "reason",
  "status",
  "typescript",
  "typescriptSymbols",
  "unitTest",
] as const;

export const evidenceLanes = ["declarationTest", "realTmuxScenario", "unitTest"] as const;

export function fail(message: string): never {
  throw new Error(message);
}

export function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(object).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${path} must contain exactly: ${expected.join(", ")}`);
  }
}

export function stringAt(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path}.${key} must be a string`);
  }
  return value;
}

function nullableStringAt(
  object: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = object[key];
  if (value !== null && typeof value !== "string") {
    fail(`${path}.${key} must be string or null`);
  }
  return value as string | null;
}

function stringArrayAt(object: Record<string, unknown>, key: string, path: string): string[] {
  const value = object[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    fail(`${path}.${key} must be a nonempty string array`);
  }
  return value as string[];
}

function stringListAt(object: Record<string, unknown>, key: string, path: string): string[] {
  const value = object[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0) ||
    new Set(value).size !== value.length
  ) {
    fail(`${path}.${key} must be an array of unique nonempty strings`);
  }
  return value as string[];
}

function validateEvidenceApplicability(
  object: Record<string, unknown>,
  path: string,
): EvidenceApplicabilityFields {
  const applicability = objectAt(object.evidenceApplicability, `${path}.evidenceApplicability`);
  exactKeys(applicability, evidenceLanes, `${path}.evidenceApplicability`);
  for (const lane of evidenceLanes) {
    const value = stringAt(applicability, lane, `${path}.evidenceApplicability`);
    if (value !== "required" && !/^not-applicable: \S/.test(value)) {
      fail(
        `${path}.evidenceApplicability.${lane} must be required or include a not-applicable reason`,
      );
    }
    if (value.includes("owned by observable behavior records")) {
      fail(`${path}.evidenceApplicability.${lane} cannot delegate through free-form text`);
    }
  }
  return applicability as unknown as EvidenceApplicabilityFields;
}

function validateEvidence(object: Record<string, unknown>, path: string): void {
  const status = object.status;
  if (!(["planned", "implemented", "adapted", "unsupported"] as unknown[]).includes(status)) {
    fail(`${path} has invalid status`);
  }
  const typedStatus = status as Status;
  const typescript = nullableStringAt(object, "typescript", path);
  const unitTest = nullableStringAt(object, "unitTest", path);
  const adaptation = nullableStringAt(object, "adaptation", path);
  const reason = nullableStringAt(object, "reason", path);
  const typescriptSymbols = stringListAt(object, "typescriptSymbols", path);
  const declarationTest = nullableStringAt(object, "declarationTest", path);
  const realTmuxScenario = nullableStringAt(object, "realTmuxScenario", path);
  const evidenceApplicability = validateEvidenceApplicability(object, path);

  if ((typedStatus === "implemented" || typedStatus === "adapted") && !typescript) {
    fail(`${path} activated records require a TypeScript target`);
  }
  if (
    (typedStatus === "implemented" || typedStatus === "adapted") &&
    typescriptSymbols.length === 0
  ) {
    fail(`${path} activated records require TypeScript symbols`);
  }
  if (typedStatus === "unsupported" && typescriptSymbols.length !== 0) {
    fail(`${path} unsupported records cannot name TypeScript symbols`);
  }
  if (typedStatus === "adapted" && !adaptation) {
    fail(`${path} adapted records require an adaptation`);
  }
  if (typedStatus === "unsupported" && !reason) {
    fail(`${path} unsupported records require a reason`);
  }
  const activated = typedStatus !== "planned";
  const evidence = { declarationTest, realTmuxScenario, unitTest };
  for (const lane of evidenceLanes) {
    const applicability = evidenceApplicability[lane];
    if (activated && applicability === "required" && !evidence[lane]) {
      fail(`${path} activated records require ${lane} evidence`);
    }
    if (applicability !== "required" && evidence[lane] !== null) {
      fail(`${path}.${lane} must be null when its evidence lane is not applicable`);
    }
  }
  if (typescript?.startsWith("planned:")) {
    fail(`${path} contains a fabricated planned target`);
  }
}

export function parseManifest(value: unknown): ParityManifest {
  const manifest = objectAt(value, "manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "baseline",
      "runtimeBoundary",
      "publicSymbols",
      "observableBehaviors",
      "typescriptExtensions",
      "internalExclusions",
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== 2) fail("manifest.schemaVersion must be 2");

  const baseline = objectAt(manifest.baseline, "manifest.baseline");
  exactKeys(baseline, ["pythonVersion", "tag", "commit"], "manifest.baseline");
  stringAt(baseline, "pythonVersion", "manifest.baseline");
  stringAt(baseline, "tag", "manifest.baseline");
  const commit = stringAt(baseline, "commit", "manifest.baseline");
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("manifest.baseline.commit must be a full commit");

  const boundary = objectAt(manifest.runtimeBoundary, "manifest.runtimeBoundary");
  exactKeys(boundary, ["includes", "excludes"], "manifest.runtimeBoundary");
  stringAt(boundary, "includes", "manifest.runtimeBoundary");
  stringArrayAt(boundary, "excludes", "manifest.runtimeBoundary");

  if (!Array.isArray(manifest.publicSymbols)) fail("manifest.publicSymbols must be an array");
  for (const [index, value] of manifest.publicSymbols.entries()) {
    const path = `manifest.publicSymbols[${index}]`;
    const record = objectAt(value, path);
    exactKeys(record, [...evidenceKeys, "kind", "owner", "python", "source"], path);
    for (const key of ["kind", "owner", "python", "source"]) stringAt(record, key, path);
    validateEvidence(record, path);
  }

  if (!Array.isArray(manifest.observableBehaviors)) {
    fail("manifest.observableBehaviors must be an array");
  }
  for (const [index, value] of manifest.observableBehaviors.entries()) {
    const path = `manifest.observableBehaviors[${index}]`;
    const record = objectAt(value, path);
    exactKeys(record, [...evidenceKeys, "id", "owners", "pythonEvidence"], path);
    stringAt(record, "id", path);
    stringArrayAt(record, "owners", path);
    stringArrayAt(record, "pythonEvidence", path);
    if (!nullableStringAt(record, "adaptation", path)) {
      fail(`${path}.adaptation must be a string`);
    }
    validateEvidence(record, path);
  }

  if (!Array.isArray(manifest.typescriptExtensions)) {
    fail("manifest.typescriptExtensions must be an array");
  }
  for (const [index, value] of manifest.typescriptExtensions.entries()) {
    const path = `manifest.typescriptExtensions[${index}]`;
    const record = objectAt(value, path);
    exactKeys(record, [...evidenceKeys, "id", "rationale"], path);
    stringAt(record, "id", path);
    stringAt(record, "rationale", path);
    stringAt(record, "typescript", path);
    validateEvidence(record, path);
  }

  if (!Array.isArray(manifest.internalExclusions)) {
    fail("manifest.internalExclusions must be an array");
  }
  for (const [index, value] of manifest.internalExclusions.entries()) {
    const path = `manifest.internalExclusions[${index}]`;
    const record = objectAt(value, path);
    exactKeys(record, [...evidenceKeys, "id", "pythonEvidence"], path);
    stringAt(record, "id", path);
    stringArrayAt(record, "pythonEvidence", path);
    validateEvidence(record, path);
    if (record.status !== "unsupported") fail(`${path}.status must be unsupported`);
  }

  for (const [name, records] of [
    ["publicSymbols", manifest.publicSymbols],
    ["observableBehaviors", manifest.observableBehaviors],
    ["typescriptExtensions", manifest.typescriptExtensions],
    ["internalExclusions", manifest.internalExclusions],
  ] as const) {
    const keys = (records as Array<Record<string, unknown>>).map((record) =>
      name === "publicSymbols"
        ? `${String(record.kind)}:${String(record.python)}`
        : String(record.id),
    );
    if (new Set(keys).size !== keys.length) fail(`manifest.${name} keys must be unique`);
  }

  return manifest as unknown as ParityManifest;
}

export function parseBaseline(value: unknown): ParityBaseline {
  const baseline = objectAt(value, "baseline");
  exactKeys(baseline, ["schemaVersion", "generatedFrom", "objects", "symbols"], "baseline");
  if (baseline.schemaVersion !== 1) fail("baseline.schemaVersion must be 1");
  const from = objectAt(baseline.generatedFrom, "baseline.generatedFrom");
  exactKeys(from, ["repository", "tag", "commit"], "baseline.generatedFrom");
  for (const key of ["repository", "tag", "commit"]) {
    stringAt(from, key, "baseline.generatedFrom");
  }
  const objects = objectAt(baseline.objects, "baseline.objects");
  for (const [path, kind] of Object.entries(objects)) {
    if (kind !== "blob" && kind !== "tree") {
      fail(`baseline.objects[${path}] must be blob or tree`);
    }
  }
  if (!Array.isArray(baseline.symbols) || baseline.symbols.length === 0) {
    fail("baseline.symbols must be a nonempty array");
  }
  for (const [index, entry] of baseline.symbols.entries()) {
    const path = `baseline.symbols[${index}]`;
    const record = objectAt(entry, path);
    exactKeys(record, ["kind", "owner", "python", "source"], path);
    for (const key of ["kind", "owner", "python", "source"]) stringAt(record, key, path);
  }
  return baseline as unknown as ParityBaseline;
}

export function evidenceRecords(
  manifest: ParityManifest,
): Array<{ key: string; kind: ParityKind | null; record: EvidenceFields }> {
  return [
    ...manifest.publicSymbols.map((record) => ({
      key: `${record.kind}:${record.python}`,
      kind: record.kind,
      record,
    })),
    ...manifest.observableBehaviors.map((record) => ({ key: record.id, kind: null, record })),
    ...manifest.typescriptExtensions.map((record) => ({ key: record.id, kind: null, record })),
    ...manifest.internalExclusions.map((record) => ({ key: record.id, kind: null, record })),
  ];
}

const requiredRealTmuxSymbols = new Set([
  "libtmux.common.tmux_cmd",
  "libtmux.common.get_version",
  "libtmux.common.get_version_str",
  "libtmux.common.has_gt_version",
  "libtmux.common.has_gte_version",
  "libtmux.common.has_lt_version",
  "libtmux.common.has_lte_version",
  "libtmux.common.has_minimum_version",
  "libtmux.common.has_version",
  "libtmux.neo.fetch_obj",
  "libtmux.neo.fetch_objs",
  "libtmux.pytest_plugin.TestServer",
  "libtmux.pytest_plugin.control_mode",
  "libtmux.pytest_plugin.server",
  "libtmux.pytest_plugin.session",
  "libtmux.test.temporary.temp_session",
  "libtmux.test.temporary.temp_window",
]);

const NOT_PORTED = "not-applicable: the symbol is not ported, so it has no evidence to record";
const plannedNeoSymbols = new Set(["libtmux.neo.fetch_obj", "libtmux.neo.fetch_objs"]);

export function publicSymbolEvidenceApplicability(
  kind: ParityKind,
  python: string,
  status: Status,
): EvidenceApplicabilityFields {
  if (status === "unsupported") {
    return { declarationTest: NOT_PORTED, realTmuxScenario: NOT_PORTED, unitTest: NOT_PORTED };
  }
  const realTmuxRequired =
    kind === "method" ||
    kind === "compatibility-alias" ||
    kind === "property" ||
    requiredRealTmuxSymbols.has(python);
  if (python.startsWith("libtmux.neo") && !plannedNeoSymbols.has(python)) {
    return {
      declarationTest: NOT_PORTED,
      realTmuxScenario: NOT_PORTED,
      unitTest: NOT_PORTED,
    };
  }
  if (realTmuxRequired) {
    return {
      declarationTest:
        "not-applicable: the member's declaration is pinned with its class, not one test per member",
      realTmuxScenario: "required",
      unitTest:
        "not-applicable: the behaviour is a tmux command, so it is exercised against a real server rather than a mock",
    };
  }
  return {
    declarationTest: "required",
    realTmuxScenario: "not-applicable: symbol has no direct tmux I/O behavior",
    unitTest: "required",
  };
}

function knownTarget(kind: ParityKind, python: string): string | null {
  if (kind === "root-export") return python.slice("libtmux.".length);
  if (kind === "enum-member") return python.slice("libtmux.constants.".length);
  return null;
}

function knownTypeScriptSymbols(kind: ParityKind, python: string): string[] {
  if (kind === "root-export") return [`.#value:${python.slice("libtmux.".length)}`];
  if (kind === "enum-member") {
    return [`./constants#value:${python.slice("libtmux.constants.".length)}`];
  }
  return [];
}

export function createPlannedSymbol(
  kind: ParityKind,
  python: string,
  source: string,
): PublicSymbol {
  return {
    adaptation: null,
    declarationTest: null,
    evidenceApplicability: publicSymbolEvidenceApplicability(kind, python, "planned"),
    kind,
    owner: python.slice(0, python.lastIndexOf(".")),
    python,
    realTmuxScenario: null,
    reason: null,
    source,
    status: "planned",
    typescript: knownTarget(kind, python),
    typescriptSymbols: knownTypeScriptSymbols(kind, python),
    unitTest: null,
  };
}

export function baselineSymbol(entry: ParityBaseline["symbols"][number]): PublicSymbol {
  return { ...createPlannedSymbol(entry.kind, entry.python, entry.source), owner: entry.owner };
}

export function symbolKey(symbol: PublicSymbol): string {
  return `${symbol.kind}:${symbol.python}`;
}
