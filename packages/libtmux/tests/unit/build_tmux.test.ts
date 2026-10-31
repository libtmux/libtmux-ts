import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../../../scripts/build-tmux.sh", import.meta.url).pathname;

/**
 * A repository shaped like tmux's: an `autogen.sh` that writes `configure`,
 * which writes a Makefile whose install puts a tmux that prints the VERSION
 * file of the commit it was built from. It has an annotated tag, a branch, and
 * a commit only the branch reaches, so the script is tested without a network.
 */
const configure = `for argument in "$@"; do
	case $argument in --prefix=*) prefix=\${argument#--prefix=} ;; esac
done
printf 'PREFIX = %s\\n' "$prefix" > Makefile
printf 'all:\\n\\t@true\\ninstall:\\n\\tmkdir -p $(PREFIX)/bin\\n' >> Makefile
printf '\\tprintf "#!/bin/sh\\\\necho tmux %%s\\\\n" "$$(cat VERSION)" > $(PREFIX)/bin/tmux\\n' >> Makefile
printf '\\tchmod +x $(PREFIX)/bin/tmux\\n' >> Makefile
`;
const autogen = `cat > configure <<'CONFIGURE'\n${configure}CONFIGURE\nchmod +x configure\n`;

let scratch = "";
let url = "";
const commits: Record<"branch" | "master" | "tag", string> = { branch: "", master: "", tag: "" };

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "init.defaultBranch=master",
      ...args,
    ],
    cwd: directory,
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, PATH: process.env.PATH ?? "" },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ltx-build-tmux-"));
  const upstream = join(scratch, "upstream");
  mkdirSync(upstream);
  const commit = (version: string): string => {
    writeFileSync(join(upstream, "VERSION"), `${version}\n`);
    git(upstream, "add", ".");
    git(upstream, "commit", "--quiet", "--message", version);
    return git(upstream, "rev-parse", "HEAD");
  };
  git(upstream, "init", "--quiet");
  writeFileSync(join(upstream, "autogen.sh"), autogen);
  commits.tag = commit("tagged");
  git(upstream, "tag", "--annotate", "--message", "release", "9.9");
  git(upstream, "branch", "feature/x");
  commits.master = commit("master");
  git(upstream, "switch", "--quiet", "feature/x");
  commits.branch = commit("branch");
  git(upstream, "switch", "--quiet", "master");
  git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
  url = `file://${upstream}`;
});

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { force: true, recursive: true });
});

function run(...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bash", script, ...args],
    env: {
      HOME: scratch,
      PATH: process.env.PATH ?? "",
      TMPDIR: scratch,
      TMUX_REPOSITORY: url,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString().trim(),
  };
}

describe("resolving a ref", () => {
  test.each([
    ["an annotated tag, to the commit it tags", "9.9", (): string => commits.tag],
    ["a branch", "master", (): string => commits.master],
    ["a branch with a slash", "feature/x", (): string => commits.branch],
    [
      "a commit, to itself",
      "0123456789abcdef0123456789abcdef01234567",
      (): string => "0123456789abcdef0123456789abcdef01234567",
    ],
  ] as const)("%s", (_name, ref, expected) => {
    const result = run("resolve", ref);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected());
  });

  test.each([
    ["a ref nothing names", ["resolve", "9.8"], "has no tag or branch named 9.8"],
    ["a shell metacharacter", ["resolve", "9.9;id"], "not a tmux ref"],
    ["a leading dash", ["resolve", "-abc"], "not a tmux ref"],
    ["an overlong ref", ["resolve", "a".repeat(65)], "not a tmux ref"],
    ["no mode", [], "usage"],
    ["a build without a prefix", ["build", "9.9"], "usage"],
  ] as const)("refuses %s", (_name, args, message) => {
    const result = run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});

describe("building a ref", () => {
  test.each([
    ["a tag", "9.9", (): string => commits.tag, "tmux tagged"],
    ["a branch", "feature/x", (): string => commits.branch, "tmux branch"],
    ["a commit", "$master", (): string => commits.master, "tmux master"],
  ] as const)("builds the commit that %s names", (_name, ref, expected, reported) => {
    const prefix = join(scratch, `prefix-${ref.replaceAll(/[^a-z0-9]/gu, "_")}`);
    const named = ref === "$master" ? commits.master : ref;
    const result = run("build", named, prefix);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(expected());
    const built = Bun.spawnSync({ cmd: [join(prefix, "bin/tmux")], stdout: "pipe" });
    expect(built.stdout.toString().trim()).toBe(reported);
  });
});
