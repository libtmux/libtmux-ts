/**
 * The unit and integration suites on Node 22, against `dist`.
 *
 * Bun runs these files against `src`. This runs the same files against the
 * artifact a Node consumer loads, with `bun:test` answered by a vitest shim.
 * `LTX_NODE_SUITE` picks `unit` or `integration`.
 *
 * What does not run here is listed with its reason. Each is a gate over the
 * repository rather than over the library, or needs Bun as the tool it drives;
 * none is a library test that fails on Node. A renamed test drops out of the
 * name list and runs here, so a stale entry fails loudly rather than skipping
 * quietly.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const REPOSITORY_GATES: Readonly<Record<string, string>> = {
  "integration/test_runners": "the repository's own runners, spawned under bun",
  "unit/bounded_process": "a repository script's process helper",
  "unit/error_identity": "bundles a consumer with Bun.build",
  "unit/mcp_swap": "swaps the MCP package's library under bun",
  "unit/npm_pack": "packs the published tarball",
  "unit/package_analysis": "analyses the package with bun",
  "unit/package_contract": "checks the manifest and spawns bun",
  "unit/parity_manifest": "checks the parity ledger against tsc",
  "unit/publish_release": "the release workflow",
  "unit/source_map_gate": "builds and inspects source maps with bun",
  "unit/thrown_exports": "scans source text",
  "unit/type_performance_gate": "measures tsc",
  "unit/typescript_api": "the tsc runner the gates share",
};

const REPOSITORY_TESTS: Readonly<Record<string, string>> = {
  "CLI accepts exactly one explicit mode and rejected forms never write": "the format generator",
  "every claimed TypeScript symbol exists in the package": "the parity ledger",
  "root reference types are type-only exports and helpers are values": "compiles with tsc",
  "runs the Python oracle and emitted library under Bun and Node 22": "drives both runtimes itself",
  "runs the shared corpus through Bun's native engine": "Bun's regex engine, by name",
  "writes exact relation metadata and only the delimited cyclic interfaces": "compiles with tsc",
};

const suite = process.env.LTX_NODE_SUITE ?? "unit";
const escaped = Object.keys(REPOSITORY_TESTS).map((name) =>
  name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "bun:test",
        replacement: fileURLToPath(new URL("./tests/support/bun_test_on_node.ts", import.meta.url)),
      },
      // The suites import `../../src/…`; Node's lane tests what was emitted.
      { find: /^((?:\.\.\/)+)src\//u, replacement: "$1dist/" },
    ],
  },
  test: {
    exclude: Object.keys(REPOSITORY_GATES).map((gate) => `tests/${gate}.test.ts`),
    include: [`tests/${suite}/**/*.test.ts`],
    pool: "forks",
    testNamePattern: new RegExp(`^(?!.*(?:${escaped.join("|")})).*$`, "u"),
  },
});
