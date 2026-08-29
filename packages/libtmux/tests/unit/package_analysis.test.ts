import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { killIfRunning, processExists, waitForProcessExit } from "../support/converge.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

const checker = fileURLToPath(
  new URL("../../../../scripts/check-package-analysis.ts", import.meta.url),
);

async function waitForMarker(path: string): Promise<string> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- the marker makes analyzer startup observable.
    const content = await readFile(path, "utf8").catch(() => undefined);
    if (content !== undefined && /^[1-9]\d*$/u.test(content.trim())) return content.trim();
    // eslint-disable-next-line no-await-in-loop -- marker polling is sequential and bounded.
    await Bun.sleep(5);
  }
  throw new Error("package analyzer descendant did not publish its PID");
}

test.skipIf(process.platform === "win32")(
  "bounds an analyzer descendant that keeps its output pipes open",
  async () => {
    const root = await makeTestDirectory("ltx-package-analysis-bound-");
    const packageRoot = join(root, "package");
    const marker = join(root, "descendant.pid");
    const bunPreload = join(root, "bun-preload.mjs");
    const nodePreload = join(root, "node-preload.mjs");
    await mkdir(packageRoot);
    await Bun.write(
      bunPreload,
      `
const spawn = Bun.spawn.bind(Bun);
const schedule = globalThis.setTimeout;
let analyzerStarted = false;
Bun.spawn = (command, options) => {
  const child = spawn(command, options);
  const executable = Array.isArray(command) ? command[0] : command.cmd?.[0];
  if (typeof executable === "string" && executable.endsWith("/publint")) {
    analyzerStarted = true;
  }
  return child;
};
globalThis.setTimeout = (callback, delay, ...arguments_) => {
  const scaled = analyzerStarted && delay === 60_000
    ? 250
    : analyzerStarted && delay === 65_000
      ? 500
      : delay;
  return schedule(callback, scaled, ...arguments_);
};
`,
    );
    await Bun.write(
      nodePreload,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.argv.some((argument) => argument.includes("publint"))) {
  const descendant = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(
      'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 4_000);',
    )}],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  writeFileSync(${JSON.stringify(marker)}, String(descendant.pid));
  setInterval(() => {}, 60_000);
}
`,
    );
    await Bun.write(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        files: ["index.d.ts", "index.js"],
        name: "ltx-package-analysis-fixture",
        type: "module",
        version: "1.0.0",
      })}\n`,
    );
    await Promise.all([
      writeFile(join(packageRoot, "index.d.ts"), "export declare const value: number;\n"),
      writeFile(join(packageRoot, "index.js"), "export const value = 1;\n"),
    ]);

    const analysis = Bun.spawn([process.execPath, "--preload", bunPreload, checker], {
      cwd: packageRoot,
      env: {
        ...process.env,
        BUN_FEATURE_FLAG_NO_ORPHANS: "0",
        NODE_OPTIONS: `--import=${nodePreload}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const completion = Promise.all([
      analysis.exited,
      new Response(analysis.stdout).text(),
      new Response(analysis.stderr).text(),
    ]);
    let descendantPid = 0;

    try {
      try {
        descendantPid = Number(await waitForMarker(marker));
      } catch (error) {
        const [exitCode, stdout, stderr] = await completion;
        throw new Error(
          `${(error as Error).message}; checker exited ${String(exitCode)}\n${stdout}${stderr}`,
        );
      }
      const startedAt = performance.now();
      const [exitCode, stdout, stderr] = await completion;

      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("publint exceeded 60000ms");
      await waitForProcessExit(descendantPid);
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (processExists(analysis.pid)) killIfRunning(analysis.pid);
      if (descendantPid > 0) killIfRunning(descendantPid);
      await completion.catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  },
  20_000,
);
