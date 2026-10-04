import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { summarize, toCsv, toMarkdown } from "../../../../scripts/stress-summary.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

const passing = '<testcase name="holds" classname="suite a" file="a.test.ts" />';
const failing =
  '<testcase name="flakes" classname="suite a" file="a.test.ts"><failure type="x" /></testcase>';
const skipped = '<testcase name="later" classname="suite a"><skipped /></testcase>';

async function write(root: string, platform: string, repetition: string, cases: string) {
  const directory = join(root, platform, repetition);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "lib.xml"), `<testsuites>${cases}</testsuites>`);
}

test("counts a test's failures across repetitions and leaves a clean control at zero", async () => {
  const root = await makeTestDirectory("ltx-stress-summary-");
  try {
    await write(root, "macos", "1", passing + passing + failing + skipped);
    await write(root, "macos", "2", passing + failing.replace("<failure", "<error"));
    await write(root, "ubuntu", "1", passing + passing.replace("holds", "flakes"));
    const counts = summarize(root);
    const find = (platform: string, test: string) =>
      counts.find((count) => count.platform === platform && count.test === `suite a > ${test}`);
    expect(find("macos", "flakes")).toMatchObject({ failures: 2, runs: 2 });
    expect(find("macos", "holds")).toMatchObject({ failures: 0, runs: 2 });
    expect(find("macos", "later")).toBeUndefined();
    expect(find("ubuntu", "flakes")).toMatchObject({ failures: 0, runs: 1 });
    expect(toCsv(counts)).toContain("macos,lib,suite a > flakes,2,2");
    const table = toMarkdown(counts);
    expect(table).toContain("| macos | lib | suite a > flakes | 2 | 2 |");
    expect(table).not.toContain("| ubuntu |");
    expect(table).toContain("ubuntu: 2 tests, up to 1 runs each, 0 failed at least once.");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
