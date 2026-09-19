import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  collectBundledPackages,
  missingNotices,
  noticesPath,
  renderNotices,
} from "../scripts/third_party_notices.ts";

test("the shipped notices reproduce every bundled package's license", async () => {
  const packages = await collectBundledPackages();
  const current = await readFile(noticesPath, "utf8");
  expect(missingNotices(current, packages)).toEqual([]);
  expect(current).toBe(renderNotices(packages));
  for (const entry of packages) expect(current).toContain(entry.text);
});

test("a bundled package left out of the notices is named", async () => {
  const packages = await collectBundledPackages();
  const dropped = packages[0]!;
  const partial = renderNotices(packages.slice(1));
  expect(missingNotices(partial, packages).map((entry) => entry.name)).toEqual([dropped.name]);
});
