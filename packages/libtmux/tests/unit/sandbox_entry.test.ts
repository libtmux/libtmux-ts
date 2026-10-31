import { describe, expect, test } from "bun:test";

import { sandboxEntryFailures, scanSource } from "../../../../scripts/sandbox_entry.js";

const NONE: Readonly<Record<string, string>> = {};

function failures(
  source: string,
  needsNoSandbox: Readonly<Record<string, string>> = NONE,
): readonly string[] {
  return sandboxEntryFailures(new Map([["scripts/example.ts", source]]), needsNoSandbox);
}

describe("the sandbox entry rule", () => {
  test("passes a script that starts a server after entering the sandbox", () => {
    expect(failures("await enterSandbox();\nconst server = new Server({});")).toEqual([]);
    expect(failures("process.exitCode = await runSupervisor({ command: ['tmux'] });")).toEqual([]);
  });

  test.each([
    ["a Server", "const server = new Server({});"],
    ["a fixture", "const fixture = await TestServer.create({});"],
    ["a run root", "await withOwnedRunRoot('x', body, tmux);"],
    ["the tmux binary by name", "spawnSync('tmux', ['kill-server']);"],
    ["a command line that begins with tmux", "spawnSync('sh', ['-c', 'tmux kill-server']);"],
  ])("fails a script that starts %s and never enters it", (_name, source) => {
    expect(failures(source)).toEqual([
      "scripts/example.ts: starts tmux, so it calls enterSandbox from the testkit, or is listed in needsNoSandbox with the reason it needs none",
    ]);
  });

  test("does not take a comment for a call", () => {
    const source = [
      "// call enterSandbox() before this",
      "/* enterSandbox(); */",
      "const server = new Server({});",
    ].join("\n");

    expect(failures(source)).toHaveLength(1);
  });

  test("does not take a string for a call", () => {
    const source = "const note = 'enterSandbox()';\nconst server = new Server({});";

    expect(failures(source)).toHaveLength(1);
  });

  test("keeps a URL in a string whole when it strips comments", () => {
    const source = "const url = 'https://example.test/a'; // enterSandbox()";

    expect(scanSource(source).code).toContain("https://example.test/a");
    expect(scanSource(source).code).not.toContain("enterSandbox");
  });

  test("steps over an escaped quote", () => {
    const source = "const text = 'it\\'s'; await enterSandbox(); new Server({});";

    expect(failures(source)).toEqual([]);
  });

  test("ignores a script that names no server", () => {
    expect(failures("export const answer = 42;")).toEqual([]);
  });

  describe("a listed script", () => {
    const listed = (reason: string): Readonly<Record<string, string>> => ({
      "scripts/example.ts": reason,
    });

    test("passes when it names a server and says why it needs no sandbox", () => {
      expect(failures("const server = new Server({});", listed("pins every socket"))).toEqual([]);
    });

    test("fails when it starts nothing", () => {
      expect(failures("export const answer = 42;", listed("pins every socket"))).toEqual([
        "scripts/example.ts: listed in needsNoSandbox but it starts no tmux or enters the sandbox",
      ]);
    });

    test("fails when it enters the sandbox after all", () => {
      expect(
        failures("await enterSandbox();\nnew Server({});", listed("pins every socket")),
      ).toEqual([
        "scripts/example.ts: listed in needsNoSandbox but it starts no tmux or enters the sandbox",
      ]);
    });

    test("fails when it no longer exists", () => {
      expect(sandboxEntryFailures(new Map(), listed("pins every socket"))).toEqual([
        "scripts/example.ts: listed in needsNoSandbox but it starts no tmux or enters the sandbox",
      ]);
    });

    test("fails when it calls a fixture that refuses a process outside the sandbox", () => {
      expect(
        failures(
          "await TestServer.create({});",
          listed("a manual benchmark; every socket is its own"),
        ),
      ).toEqual([
        "scripts/example.ts: listed in needsNoSandbox but it calls a fixture that refuses a process outside the sandbox",
      ]);
    });

    test("passes a helper that the gates import, which does call a fixture", () => {
      expect(
        failures("await TestServer.create({});", listed("imported by the gates, which enter it")),
      ).toEqual([]);
    });
  });
});
