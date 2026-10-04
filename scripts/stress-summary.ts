/**
 * Count each test's failures across the repetitions of the macOS stress run.
 *
 * Reads `<root>/<platform>/<repetition>/<suite>.xml`, the JUnit files `bun test`
 * writes, and prints a Markdown table of every test that failed at least once
 * plus one line per platform, then writes every test's counts to a CSV. A
 * platform with no failures prints no table: the line says how many tests ran
 * and how many times, which is what separates "stable" from "never ran".
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TestCount {
  readonly failures: number;
  readonly platform: string;
  readonly runs: number;
  readonly suite: string;
  readonly test: string;
}

const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu;

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(attributes);
  return (match?.[1] ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** One JUnit document's testcases, each as `[test, failed, skipped]`. */
export function parseJunit(xml: string): { failed: boolean; skipped: boolean; test: string }[] {
  const cases: { failed: boolean; skipped: boolean; test: string }[] = [];
  for (const match of xml.matchAll(TESTCASE)) {
    const attributes = match[1] ?? "";
    const body = match[3] ?? "";
    cases.push({
      failed: /<(failure|error)\b/u.test(body),
      skipped: /<skipped\b/u.test(body),
      test: `${attribute(attributes, "classname")} > ${attribute(attributes, "name")}`.replace(
        /^ > /u,
        "",
      ),
    });
  }
  return cases;
}

/** Fold the files under `root` into one count per platform, suite and test. */
export function summarize(root: string): TestCount[] {
  const counts = new Map<string, { failures: number; runs: number }>();
  for (const platform of readdirSync(root).toSorted()) {
    for (const repetition of readdirSync(join(root, platform)).toSorted()) {
      for (const file of readdirSync(join(root, platform, repetition)).toSorted()) {
        if (!file.endsWith(".xml")) continue;
        const suite = file.slice(0, -".xml".length);
        const text = readFileSync(join(root, platform, repetition, file), "utf8");
        // Parameterized tests share a name, so a repetition counts a name once,
        // and counts it failed when any case under it failed.
        const seen = new Map<string, boolean>();
        for (const { failed, skipped, test } of parseJunit(text)) {
          if (skipped) continue;
          seen.set(test, (seen.get(test) ?? false) || failed);
        }
        for (const [test, failed] of seen) {
          const key = JSON.stringify([platform, suite, test]);
          const entry = counts.get(key) ?? { failures: 0, runs: 0 };
          entry.runs += 1;
          if (failed) entry.failures += 1;
          counts.set(key, entry);
        }
      }
    }
  }
  return [...counts].map(([key, entry]) => {
    const [platform, suite, test] = JSON.parse(key) as [string, string, string];
    return { ...entry, platform, suite, test };
  });
}

function csvField(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(counts: readonly TestCount[]): string {
  const rows = counts.map((count) =>
    [count.platform, count.suite, count.test, count.runs, count.failures]
      .map((field) => csvField(String(field)))
      .join(","),
  );
  return `${["platform,suite,test,runs,failures", ...rows].join("\n")}\n`;
}

export function toMarkdown(counts: readonly TestCount[]): string {
  const platforms = [...new Set(counts.map((count) => count.platform))].toSorted();
  const lines: string[] = [];
  for (const platform of platforms) {
    const mine = counts.filter((count) => count.platform === platform);
    const failing = mine.filter((count) => count.failures > 0);
    const repetitions = Math.max(0, ...mine.map((count) => count.runs));
    lines.push(
      `${platform}: ${String(mine.length)} tests, up to ${String(repetitions)} runs each, ` +
        `${String(failing.length)} failed at least once.`,
    );
  }
  const failing = counts
    .filter((count) => count.failures > 0)
    .toSorted((left, right) => right.failures - left.failures);
  if (failing.length > 0) {
    lines.push(
      "",
      "| platform | suite | test | failed | runs |",
      "| --- | --- | --- | ---: | ---: |",
    );
    for (const count of failing) {
      const test = count.test.replaceAll("|", "\\|");
      lines.push(
        `| ${count.platform} | ${count.suite} | ${test} | ${String(count.failures)} | ${String(count.runs)} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const [root, csvPath] = Bun.argv.slice(2);
  if (root === undefined || csvPath === undefined) {
    process.stderr.write("usage: bun scripts/stress-summary.ts <junit-root> <csv-out>\n");
    process.exit(2);
  }
  const counts = summarize(root);
  if (counts.length === 0) {
    process.stderr.write(`no JUnit results under ${root}\n`);
    process.exit(1);
  }
  writeFileSync(csvPath, toCsv(counts));
  process.stdout.write(toMarkdown(counts));
}
