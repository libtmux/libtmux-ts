import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runTypeScriptApi } from "../support/typescript_api.js";

/**
 * The retry that keeps a cancelled Go process from failing an unrelated gate.
 *
 * TypeScript's native API is a Go program, and one started while other tsc
 * processes are running is occasionally cancelled before it answers. The retry
 * exists for exactly that signature, and the risk of a retry is that it grows
 * to cover real failures too — turning a genuine boundary violation into three
 * slow attempts and then the same violation. These pin both halves.
 *
 * `runTypeScriptApi` runs whatever script it is handed, so a script that counts
 * its own invocations makes the number of attempts observable without a mock.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ltx-tsapi-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

/**
 * A script that records one line per run, then fails with `message`.
 *
 * Under `--eval` there is no script path in `argv`, so the first argument the
 * runner forwards lands at index 1 rather than 2.
 */
function failingScript(message: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.argv[1], "run\\n");',
    `process.stderr.write(${JSON.stringify(message)});`,
    "process.exit(1);",
  ].join("\n");
}

async function runs(counter: string): Promise<number> {
  const recorded = await readFile(counter, "utf8").catch(() => "");
  return recorded.split("\n").filter((line) => line !== "").length;
}

describe("TypeScript API runner", () => {
  test("retries a cancelled process", async () => {
    const counter = join(directory, "cancelled");

    const result = await runTypeScriptApi(
      failingScript("context canceled\n"),
      [counter],
      directory,
    );

    expect(result.exitCode).toBe(1);
    expect(await runs(counter)).toBe(3);
  }, 30_000);

  test("fails a real error on the first attempt", async () => {
    const counter = join(directory, "real");

    // A boundary violation must not be retried: it would cost three runs and
    // report the same failure, while reading as flakiness rather than a defect.
    const result = await runTypeScriptApi(
      failingScript("Selection leaked an internal type\n"),
      [counter],
      directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Selection leaked an internal type");
    expect(await runs(counter)).toBe(1);
  }, 30_000);

  test("returns a success without running again", async () => {
    const counter = join(directory, "ok");
    const script = [
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(process.argv[1], "run\\n");',
      'process.stdout.write("{}");',
    ].join("\n");

    const result = await runTypeScriptApi(script, [counter], directory);

    expect(result).toMatchObject({ exitCode: 0, stdout: "{}" });
    expect(await runs(counter)).toBe(1);
  }, 30_000);
});
