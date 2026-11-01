import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  changelogFailures,
  readPackageChangelogs,
  readRootChangelog,
  releaseHeadingFailure,
  rootChangelogFailures,
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

const rootPackages = [{ directory: "libtmux" }, { directory: "mcp" }];

function rootChangelog(): string {
  return [
    "# Changelog",
    "",
    "Notable changes to `libtmux-ts`.",
    "",
    "- [`libtmux`](packages/libtmux/CHANGELOG.md)",
    "- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md)",
    "",
    "## Unreleased",
    "",
    "## 1.0.0 (2026-01-02)",
    "",
  ].join("\n");
}

describe("rootChangelogFailures", () => {
  test("accepts a root changelog that opens with the repository, links every package and has an Unreleased section", () => {
    expect(rootChangelogFailures(rootChangelog(), rootPackages)).toEqual([]);
  });

  test("fails a repository with no root CHANGELOG.md", () => {
    expect(rootChangelogFailures(undefined, rootPackages)).toEqual([
      "CHANGELOG.md: the repository has no root changelog",
    ]);
  });

  test("fails a root changelog with no Unreleased section", () => {
    const changelog = rootChangelog().replace("## Unreleased\n\n", "");

    expect(rootChangelogFailures(changelog, rootPackages)).toEqual([
      'CHANGELOG.md: has no "## Unreleased" section',
    ]);
  });

  test("does not read an Unreleased heading out of a code block", () => {
    const changelog = rootChangelog().replace("## Unreleased", "```\n## Unreleased\n```");

    expect(rootChangelogFailures(changelog, rootPackages)).toEqual([
      'CHANGELOG.md: has no "## Unreleased" section',
    ]);
  });

  test("fails a root changelog that names a package instead of the repository", () => {
    const changelog = rootChangelog().replace("`libtmux-ts`", "`libtmux`");

    expect(rootChangelogFailures(changelog, rootPackages)).toEqual([
      'CHANGELOG.md: does not open with "Notable changes to `libtmux-ts`."',
    ]);
  });

  test("fails a root changelog that leaves out a package's changelog", () => {
    const changelog = rootChangelog().replace(
      "- [`@libtmux/mcp`](packages/mcp/CHANGELOG.md)\n",
      "",
    );

    expect(rootChangelogFailures(changelog, rootPackages)).toEqual([
      "CHANGELOG.md: does not link packages/mcp/CHANGELOG.md",
    ]);
  });
});

describe("releaseHeadingFailure", () => {
  test("accepts a dated heading for the release", () => {
    expect(releaseHeadingFailure(rootChangelog(), "1.0.0")).toBeUndefined();
  });

  test.each(["1.0.1", "1.0", "0.0.0"])("fails a release, %s, with no heading", (version) => {
    expect(releaseHeadingFailure(rootChangelog(), version)).toBe(
      `CHANGELOG.md: has no "## ${version} (YYYY-MM-DD)" heading for this release`,
    );
  });

  test("fails a heading with no date", () => {
    expect(releaseHeadingFailure("## 1.0.0\n", "1.0.0")).toContain("has no");
  });

  test("does not read a heading out of a code block", () => {
    expect(releaseHeadingFailure("```\n## 1.0.0 (2026-01-02)\n```\n", "1.0.0")).toContain("has no");
  });

  test("fails a repository with no root changelog", () => {
    expect(releaseHeadingFailure(undefined, "1.0.0")).toContain("no root changelog");
  });
});

describe("the repository's root changelog", () => {
  test("exists, links every package's changelog and has an Unreleased section", async () => {
    const packages = await readPackageChangelogs(repositoryRoot);

    expect(rootChangelogFailures(await readRootChangelog(repositoryRoot), packages)).toEqual([]);
  });

  test("has a heading for the release the packages are at", async () => {
    const manifest = JSON.parse(
      await readFile(`${repositoryRoot}packages/libtmux/package.json`, "utf8"),
    ) as { readonly version: string };

    expect(
      releaseHeadingFailure(await readRootChangelog(repositoryRoot), manifest.version),
    ).toBeUndefined();
  });
});
