import { existsSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve every relative link and `#anchor` in every tracked Markdown file.
 *
 * A README is the face of the repository, and the most visible way for it to
 * be wrong is a link that 404s. Nothing checked these: the ` ```ts ` blocks are
 * compiled by two gates, but the prose around them — which is most of the
 * page, and all of the navigation between packages — was unverified.
 *
 * External links are skipped deliberately. Reaching the network would make the
 * gate fail for reasons that have nothing to do with the change under test,
 * and a gate that goes red when someone else's host is down teaches people to
 * ignore it.
 */

import { slugify } from "../packages/libtmux/scripts/markdown_anchors.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface Reference {
  readonly anchor: string | undefined;
  readonly line: number;
  readonly path: string | undefined;
  readonly raw: string;
}

/**
 * Blank out fenced blocks so a link inside a code sample is not treated as one.
 *
 * Inline code spans are stripped only for the reference sweep. Doing it for
 * headings too would erase the very text the anchor is made of, and every
 * `#### `Server.colors`` in the generated reference would look anchorless.
 */
function withoutCodeFences(markdown: string, stripInlineCode: boolean): readonly string[] {
  let fenced = false;
  return markdown.split("\n").map((line) => {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      return "";
    }
    if (fenced) return "";
    return stripInlineCode ? line.replace(/`[^`]*`/gu, "") : line;
  });
}

/**
 * Every anchor GitHub would mint for a file: one per heading, plus the `-1`,
 * `-2` suffixes it appends when two headings slug identically, plus any
 * explicit HTML anchor.
 */
function anchorsOf(markdown: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of withoutCodeFences(markdown, false)) {
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading?.[1] !== undefined) {
      const base = slugify(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${String(count)}`);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/gu)) {
      if (match[1] !== undefined) anchors.add(match[1].toLowerCase());
    }
  }
  return anchors;
}

function referencesOf(markdown: string): readonly Reference[] {
  const references: Reference[] = [];
  for (const [index, line] of withoutCodeFences(markdown, true).entries()) {
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = match[1];
      if (target === undefined) continue;
      if (/^(?:https?:|mailto:|#!)/u.test(target)) continue;
      const [path, anchor] = target.split("#", 2) as [string, string | undefined];
      references.push({
        anchor,
        line: index + 1,
        path: path === "" ? undefined : path,
        raw: target,
      });
    }
  }
  return references;
}

const tracked = new Bun.$.Shell();
const listed = await tracked`git ls-files "*.md"`.cwd(repositoryRoot).text();
const files = listed
  .split("\n")
  .filter((line) => line !== "")
  // A symlinked doc is the same bytes as its target; checking it twice only
  // reports the same failure twice, under a name that does not exist.
  .filter((file) => !lstatSync(join(repositoryRoot, file)).isSymbolicLink());

const anchorCache = new Map<string, ReadonlySet<string>>();
async function anchorsFor(absolute: string): Promise<ReadonlySet<string>> {
  const cached = anchorCache.get(absolute);
  if (cached) return cached;
  const anchors = anchorsOf(await Bun.file(absolute).text());
  anchorCache.set(absolute, anchors);
  return anchors;
}

const failures: string[] = [];
let checked = 0;

for (const file of files) {
  const absolute = join(repositoryRoot, file);
  // eslint-disable-next-line no-await-in-loop -- one document at a time; failures are reported in file order.
  const markdown = await Bun.file(absolute).text();
  const own = anchorsOf(markdown);

  for (const reference of referencesOf(markdown)) {
    checked += 1;
    const where = `${file}:${String(reference.line)}`;

    if (reference.path === undefined) {
      if (reference.anchor !== undefined && !own.has(reference.anchor)) {
        failures.push(`${where}: no heading in this file yields #${reference.anchor}`);
      }
      continue;
    }

    const target = resolve(dirname(absolute), decodeURIComponent(reference.path));
    if (!existsSync(target)) {
      failures.push(`${where}: ${reference.raw} does not exist`);
      continue;
    }
    if (reference.anchor === undefined || !target.endsWith(".md")) continue;

    // eslint-disable-next-line no-await-in-loop -- the anchor set is cached, so this reads each target once.
    const anchors = await anchorsFor(target);
    if (!anchors.has(reference.anchor)) {
      failures.push(
        `${where}: ${relative(repositoryRoot, target)} has no heading yielding #${reference.anchor}`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Broken documentation links:\n${failures.map((f) => `  ${f}\n`).join("")}`);
  process.exit(1);
}

process.stdout.write(
  `Documentation links resolve: ${String(checked)} across ${String(files.length)} files\n`,
);
