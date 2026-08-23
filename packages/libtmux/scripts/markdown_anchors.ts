/**
 * GitHub's heading slug, in one place.
 *
 * Two scripts need it and they must agree: the API reference generates links
 * to its own headings, and the link checker resolves them. When the generator
 * approximated the rule instead of using it, a heading containing a computed
 * member name — `Selection.[Symbol.iterator]` — produced a link to
 * `#selection[symbol.iterator]` while the heading it pointed at slugified to
 * `#selectionsymboliterator`, and the reference shipped a link to nowhere.
 *
 * It lives beside the generator rather than beside the checker because the
 * package's tooling typecheck cannot reach outside the package, while the
 * repository's can reach in.
 *
 * Lowercase, drop everything that is not a word character, hyphen or space,
 * then hyphenate. Backticks and dots go, which is why `` `Server.colors` `` is
 * reachable as `#servercolors`.
 */
export function slugify(heading: string): string {
  return heading
    .trim()
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .toLowerCase()
    .replaceAll("`", "")
    .replace(/[^\w\- ]/gu, "")
    .replaceAll(" ", "-");
}
