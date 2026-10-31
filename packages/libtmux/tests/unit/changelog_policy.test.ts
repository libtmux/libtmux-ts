import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  changelogFailures,
  readPackageChangelogs,
  type PackageChangelog,
} from "../../../../scripts/changelog_policy.js";
import { RELEASE_PACKAGES } from "../../../../scripts/release_policy.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function changelogOf(name: string): string {
  return `# Changelog\n\nNotable changes to \`${name}\`.\n\n## Unreleased\n\n## 1.0.0\n`;
}

const conforming: PackageChangelog = {
  changelog: changelogOf("@libtmux/mcp"),
  directory: "mcp",
  files: ["assets", "CHANGELOG.md", "dist"],
  name: "@libtmux/mcp",
};

describe("changelogFailures", () => {
  test("accepts a package that ships its own changelog with an Unreleased section", () => {
    expect(changelogFailures([conforming])).toEqual([]);
  });

  test("fails a package with no CHANGELOG.md", () => {
    expect(changelogFailures([{ ...conforming, changelog: undefined }])).toEqual([
      "packages/mcp/CHANGELOG.md: @libtmux/mcp is published and has no changelog",
    ]);
  });

  test("fails a changelog with no Unreleased section", () => {
    const changelog = changelogOf("@libtmux/mcp").replace("## Unreleased\n\n", "");

    expect(changelogFailures([{ ...conforming, changelog }])).toEqual([
      'packages/mcp/CHANGELOG.md: has no "## Unreleased" section',
    ]);
  });

  test("does not read an Unreleased heading out of a code block", () => {
    const changelog = [
      "# Changelog",
      "",
      "Notable changes to `@libtmux/mcp`.",
      "",
      "```markdown",
      "## Unreleased",
      "```",
      "",
    ].join("\n");

    expect(changelogFailures([{ ...conforming, changelog }])).toEqual([
      'packages/mcp/CHANGELOG.md: has no "## Unreleased" section',
    ]);
  });

  test("fails a package that carries another package's changelog", () => {
    expect(changelogFailures([{ ...conforming, changelog: changelogOf("libtmux") }])).toEqual([
      "packages/mcp/CHANGELOG.md: is the changelog of libtmux, not @libtmux/mcp",
    ]);
  });

  test("fails a changelog that never names its package", () => {
    const changelog = "# Changelog\n\n## Unreleased\n";

    expect(changelogFailures([{ ...conforming, changelog }])).toEqual([
      'packages/mcp/CHANGELOG.md: does not open with "Notable changes to `@libtmux/mcp`."',
    ]);
  });

  test.each([[["assets", "dist"]], [undefined], ["CHANGELOG.md"]])(
    "fails a manifest whose `files` is %j",
    (files) => {
      expect(changelogFailures([{ ...conforming, files }])).toEqual([
        "packages/mcp/package.json: `files` does not ship CHANGELOG.md",
      ]);
    },
  );

  test("reports each package on its own", () => {
    const failures = changelogFailures([
      conforming,
      { ...conforming, changelog: undefined, directory: "workspace", name: "@libtmux/workspace" },
      { ...conforming, directory: "libtmux", files: [], name: "libtmux" },
    ]);

    expect(failures).toHaveLength(3);
    expect(failures.filter((failure) => failure.includes("packages/mcp/"))).toEqual([]);
  });
});

describe("the repository's packages", () => {
  test("each release package ships its own changelog", async () => {
    const packages = await readPackageChangelogs(repositoryRoot);

    expect(packages.map(({ directory }) => directory)).toEqual(
      RELEASE_PACKAGES.map(({ directory }) => directory).toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(changelogFailures(packages)).toEqual([]);
  });
});
