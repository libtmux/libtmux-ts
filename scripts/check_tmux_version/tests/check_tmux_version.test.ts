import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { makeTestDirectory } from "../../../packages/libtmux/src/_internal/test/testkit.js";
import { writeBunProgram } from "../../../packages/libtmux/tests/support/bun_program.js";
import { matchesGlob, versionMismatch } from "../check_tmux_version.js";

const script = new URL("../check_tmux_version.ts", import.meta.url).pathname;

describe("matchesGlob", () => {
  test("matches a release exactly and a development build by its prefix", () => {
    expect(matchesGlob("tmux 3.8", "tmux 3.8")).toBe(true);
    expect(matchesGlob("tmux next-3.9", "tmux next-*")).toBe(true);
    expect(matchesGlob("tmux 3.8a", "tmux *")).toBe(true);
  });

  test("refuses another release, and does not read a dot as any character", () => {
    expect(matchesGlob("tmux 3.8a", "tmux 3.8")).toBe(false);
    expect(matchesGlob("tmux 3x8", "tmux 3.8")).toBe(false);
    expect(matchesGlob("tmux 3.7", "tmux next-*")).toBe(false);
  });
});

describe("versionMismatch", () => {
  test("names the expectation and the version it got", () => {
    expect(versionMismatch("tmux 3.7", "tmux 3.8")).toBe("expected tmux 3.8, got tmux 3.7");
    expect(versionMismatch("tmux 3.8", "tmux 3.8")).toBeUndefined();
  });
});

describe("the command", () => {
  async function run(
    reported: string,
    expected: string,
  ): Promise<{ code: number; out: string; err: string }> {
    const root = await makeTestDirectory("ltx-tmux-version-");
    await mkdir(join(root, "bin"));
    await writeBunProgram(
      join(root, "bin", "tmux"),
      new URL("./fixtures/version.ts", import.meta.url),
      {
        reported,
      },
    );
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, TMUX_EXPECT: expected, TMUX_PREFIX: root },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, err, out };
  }

  test("prints the version and passes when it is the expected one", async () => {
    expect(await run("tmux 3.8", "tmux 3.8")).toEqual({ code: 0, err: "", out: "tmux 3.8\n" });
  });

  test("fails with an annotation when it is not", async () => {
    const result = await run("tmux 3.7", "tmux 3.8");
    expect(result.code).toBe(1);
    expect(result.err).toBe("::error::expected tmux 3.8, got tmux 3.7\n");
  });

  test("refuses to run without its environment", async () => {
    const child = Bun.spawn([process.execPath, script], {
      env: { PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
      stdout: "ignore",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("usage:");
  });
});
