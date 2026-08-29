import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { evidenceLanes, evidenceRecords, fail } from "./manifest.js";
import type { ParityBaseline, ParityManifest } from "./manifest.js";

const deterministicBehaviorApplicability =
  "not-applicable: behavior is deterministic over validated in-memory values";
const NOT_PORTED_BEHAVIOR =
  "not-applicable: the behavior is not ported, so it has no evidence to record";
const requiredRealTmuxBehaviors = new Set([
  "accessor.attached-sessions-exact-one",
  "accessor.error-linked-sessions",
  "accessor.error-missing-daemon-topology",
  "accessor.error-point-lookup",
  "accessor.error-propagating-relations",
  "accessor.error-schema-protocol",
  "accessor.error-server-list-leniency",
  "cmd-protocol.call",
  "collection.contextual-duplicates",
  "collection.eager-snapshots",
  "context.pane",
  "context.server",
  "context.session",
  "context.window",
]);

export function verifyBaseline(manifest: ParityManifest, baseline: ParityBaseline): void {
  const { commit, pythonVersion, tag } = manifest.baseline;
  if (pythonVersion !== "0.62.0") fail("baseline.pythonVersion must be 0.62.0");
  if (tag !== "v0.62.0") fail("baseline.tag must be v0.62.0");
  if (baseline.generatedFrom.tag !== tag) {
    fail(`baseline records ${baseline.generatedFrom.tag}, the manifest records ${tag}`);
  }
  if (baseline.generatedFrom.commit !== commit) {
    fail(`baseline records ${baseline.generatedFrom.commit}, the manifest records ${commit}`);
  }
}

function verifyPythonEvidence(
  key: string,
  values: string[],
  baselineCommit: string,
  objects: ParityBaseline["objects"],
): void {
  const canonicalPattern = new RegExp(
    `^https://github\\.com/tmux-python/libtmux/(blob|tree)/${baselineCommit}/([A-Za-z0-9_./-]+)$`,
  );
  for (const value of values) {
    const match = canonicalPattern.exec(value);
    if (!match?.[1] || !match[2]) {
      fail(`${key} Python evidence must be canonical and pinned to baseline commit: ${value}`);
    }
    const [, linkKind, objectPath] = match;
    if (objectPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail(`${key} Python evidence must be canonical and pinned to baseline commit: ${value}`);
    }
    const objectKind = objects[objectPath];
    if (objectKind === undefined) {
      fail(
        `${key} Python evidence is not recorded in the baseline: ${value}\n` +
          "Regenerate the baseline against a libtmux checkout to admit a new path.",
      );
    }
    const expectedKind = linkKind === "blob" ? "blob" : "tree";
    if (objectKind !== expectedKind) {
      fail(`${key} Python evidence URL kind does not match its Git object: ${value}`);
    }
  }
}

export function verifyManualProvenance(
  manifest: ParityManifest,
  objects: ParityBaseline["objects"],
): void {
  const publicSymbolKeys = new Set(manifest.publicSymbols.map(({ python }) => python));
  for (const behavior of manifest.observableBehaviors) {
    for (const owner of behavior.owners) {
      if (!publicSymbolKeys.has(owner)) {
        fail(`${behavior.id} owner is not an exact public symbol key: ${owner}`);
      }
    }
    const expectedApplicability =
      behavior.status === "unsupported"
        ? NOT_PORTED_BEHAVIOR
        : requiredRealTmuxBehaviors.has(behavior.id)
          ? "required"
          : deterministicBehaviorApplicability;
    if (behavior.evidenceApplicability.realTmuxScenario !== expectedApplicability) {
      fail(`${behavior.id} has invalid realTmuxScenario applicability`);
    }
    verifyPythonEvidence(behavior.id, behavior.pythonEvidence, manifest.baseline.commit, objects);
  }
  for (const exclusion of manifest.internalExclusions) {
    verifyPythonEvidence(exclusion.id, exclusion.pythonEvidence, manifest.baseline.commit, objects);
  }
}

const evidencePathPatterns = {
  declarationTest: /^tests\/(?:types|fixtures\/negative-declarations)\/[a-z0-9_./-]+\.test\.ts$/,
  realTmuxScenario: /^tests\/(?:integration|differential)\/[a-z0-9_./-]+\.test\.ts$/,
  unitTest: /^tests\/unit\/[a-z0-9_./-]+\.test\.ts$/,
} as const;

export function verifyEvidencePaths(manifest: ParityManifest, packageRoot: string): void {
  for (const { key, record } of evidenceRecords(manifest)) {
    for (const lane of evidenceLanes) {
      const path = record[lane];
      if (path === null) continue;
      if (!evidencePathPatterns[lane].test(path)) {
        fail(`${key} has invalid ${lane} evidence path: ${path}`);
      }
      const absolutePath = resolve(packageRoot, path);
      const packageRelative = relative(packageRoot, absolutePath);
      if (
        packageRelative !== path ||
        packageRelative === ".." ||
        packageRelative.startsWith("../") ||
        isAbsolute(packageRelative)
      ) {
        fail(`${key} evidence path escapes the package: ${path}`);
      }
      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        fail(`${key} evidence path does not exist: ${path}`);
      }
      const realRelative = relative(packageRoot, realpathSync(absolutePath));
      if (realRelative === ".." || realRelative.startsWith("../") || isAbsolute(realRelative)) {
        fail(`${key} evidence path resolves outside the package: ${path}`);
      }
    }
  }
}
