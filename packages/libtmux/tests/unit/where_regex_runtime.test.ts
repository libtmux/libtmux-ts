import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { resolveNode22 } from "../../src/_internal/test/node22.js";
import { requireBuiltPackage } from "../support/built_package.js";

interface RuntimeReport {
  readonly cases: readonly { readonly id: string; readonly matched: boolean }[];
  readonly implementation: string;
  readonly protocol: string;
  readonly runtime: string;
  readonly status: "passed";
}

const tsRoot = new URL("../..", import.meta.url);
const tsRootPath = fileURLToPath(tsRoot);

async function runBounded(command: readonly string[], milliseconds = 30_000) {
  const child = Bun.spawn([...command], {
    cwd: tsRootPath,
    stderr: "pipe",
    stdout: "pipe",
  });
  let deadlineReached = false;
  const terminate = setTimeout(() => {
    deadlineReached = true;
    child.kill("SIGTERM");
  }, milliseconds);
  const kill = setTimeout(() => child.kill("SIGKILL"), milliseconds + 500);
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

function decodeReport(stdout: string): RuntimeReport {
  const report = JSON.parse(stdout) as RuntimeReport;
  expect(report.protocol).toBe("libtmux-where-regex-v1");
  expect(report.status).toBe("passed");
  expect(report.cases.length).toBe(19);
  expect(new Set(report.cases.map(({ id }) => id)).size).toBe(19);
  return report;
}

describe("three-runtime regex corpus", () => {
  test("resolves one executable Node 22 runtime", async () => {
    expect(isAbsolute(await resolveNode22())).toBe(true);
  });

  test("runs the Python oracle and emitted library under Bun and Node 22", async () => {
    const python = await runBounded([
      "python3",
      "-I",
      "-B",
      "tests/differential/where_regex_oracle.py",
    ]);
    expect(python.exitCode, python.stderr).toBe(0);
    expect(python.stderr).toBe("");
    expect(decodeReport(python.stdout).implementation).toBe("python-native-re");

    await requireBuiltPackage();

    const bun = await runBounded(["bun", "tests/fixtures/where_regex_runtime.mjs", "bun"]);
    expect(bun.exitCode, bun.stderr).toBe(0);
    expect(bun.stderr).toBe("");
    expect(decodeReport(bun.stdout).implementation).toBe("bun-native-regexp");

    const nodeExecutable = await resolveNode22();
    const node = await runBounded([
      nodeExecutable,
      "tests/fixtures/where_regex_runtime.mjs",
      "node",
    ]);
    expect(node.exitCode, node.stderr).toBe(0);
    expect(node.stderr).toBe("");
    expect(decodeReport(node.stdout).implementation).toBe("node-native-regexp");
  }, 90_000);
});
