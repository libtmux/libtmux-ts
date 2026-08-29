import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { npmPack } from "../../../../scripts/npm_pack.js";
import { makeTestDirectory } from "../../src/_internal/test/temp_root.js";

test("packs the exact npm artifact and reports its entries", async () => {
  const root = await makeTestDirectory("ltx-npm-pack-");
  const destination = join(root, "artifacts");
  try {
    await mkdir(destination);
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ files: ["index.js"], name: "ltx-pack-fixture", version: "1.2.3" })}\n`,
      ),
      writeFile(join(root, "index.js"), "export const value = 1;\n"),
      writeFile(join(root, "excluded.js"), "throw new Error('must not ship');\n"),
    ]);

    const packed = await npmPack(root, destination);

    expect(packed.filename).toBe("ltx-pack-fixture-1.2.3.tgz");
    expect(packed.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    expect(packed.name).toBe("ltx-pack-fixture");
    expect(packed.version).toBe("1.2.3");
    expect(packed.entries).toEqual(["index.js", "package.json"]);
    expect(await Bun.file(packed.tarballPath).exists()).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
