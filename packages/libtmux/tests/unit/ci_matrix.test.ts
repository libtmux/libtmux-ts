import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PlanError, parseCiMatrix } from "../../../../scripts/ci_matrix.js";

const repositoryRoot = new URL("../../../../", import.meta.url).pathname;

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof PlanError) return error.message;
    throw error;
  }
  throw new Error("expected the manifest to be refused");
};

describe("the manifest", () => {
  const valid = "supported 3.3a\nsupported 3.8\nbun 1.4.0\nlane-bun 1.4.0\n";

  test.each([
    ["no supported release", "bun 1.4.0\nlane-bun 1.4.0\n", "no supported tmux release"],
    ["no Bun version", "supported 3.3a\n", "no Bun version"],
    ["no lane Bun", "supported 3.3a\nbun 1.4.0\n", "one Bun version for the tmux lanes"],
    ["a lane Bun the gates do not run", `${valid}bun 1.4.2\nlane-bun 1.3.14\n`, "one Bun version"],
    ["a lane Bun outside the matrix", "supported 3.3a\nbun 1.4.0\nlane-bun 1.3.14\n", "does not"],
    ["an unknown kind", `${valid}beta 3.9\n`, "unknown kind"],
    ["a repeated release", `${valid}refused 3.3a\n`, "repeats tmux 3.3a"],
    ["a repeated Bun", `${valid}bun 1.4.0\n`, "repeats bun 1.4.0"],
    ["a line without a value", `${valid}refused\n`, "malformed"],
    ["a line with extra words", `${valid}refused 3.2a 3.1c\n`, "malformed"],
    ["a release with a pipe", `${valid}refused 3.2a|id\n`, "invalid tmux ref"],
    ["a Bun version with a $", `${valid}bun $HOME\n`, "invalid Bun version"],
  ] as const)("is refused with %s", (_name, text, message) => {
    expect(refusal(() => parseCiMatrix(text))).toContain(message);
  });

  test("the real one lists releases oldest first", () => {
    const real = parseCiMatrix(readFileSync(join(repositoryRoot, ".github/ci-matrix.txt"), "utf8"));
    const key = (release: string): readonly [number, number, string] => {
      const found = /^(\d+)\.(\d+)([a-z]?)$/u.exec(release);
      if (found === null) throw new Error(`${release} is not a tmux release`);
      return [Number(found[1]), Number(found[2]), found[3] ?? ""];
    };
    const ordered = [...real.supported].sort((left, right) => {
      const [a, b] = [key(left), key(right)];
      return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
    });
    expect(real.supported).toEqual(ordered);
  });
});
