# Writing

Repository-specific rules for prose, TSDoc, source comments, changelogs, and
commits in `libtmux-ts`. Organization-wide voice, CommonMark wrapping, and
commit conventions live in
[libtmux/.github `WRITING.md`](https://github.com/libtmux/.github/blob/main/WRITING.md);
development workflow and gates live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Voice and terminology

Do not explain TypeScript to TypeScript developers; explain this project's
semantics. Types describe shape and documentation describes meaning — a sentence
that restates a signature says nothing.

- Keep domain nouns stable: `capture` refers to `Pane.capture`, while `snapshot`
  refers to `Server.snapshot`.
- Write `tmux` in lowercase everywhere, including at the start of a sentence;
  rewrite the sentence rather than capitalizing it. TypeScript, Bun, and Node
  keep their capitalization.
- Put identifiers, flags, environment variables, and paths in backticks.
- Do not write symbol or field counts, line numbers, bare SHAs, or local paths
  into prose.

## README shape

Both the root `README.md` and each package `README.md` follow this shape:

- Open with the logo block, a centered title, a one-sentence contract, and a
  badge row (CI, npm version when published, libtmux.org docs, license). Link
  only pages that return 200.
- Place installation and runtime floors (such as tmux 3.3a+, Node 22+ or Bun
  1.3.14+) right ahead of `Quickstart` / `Quick start` so readers reach runnable
  code immediately.
- Make each `##` heading a task in the reader's words, and each `###` heading a
  linked API name, a colon, and its job in plain words.
- Under each `###` heading, give a line or two naming linked sibling APIs, a
  self-contained `ts` example starting with its imports, what it prints, at most
  one short note, and a `More:` link to `docs/` or `libtmux.org`.
- Every example starts its own private tmux server through the library and stops
  it on exit (`try ... finally { await server.kill(); }`), without shell `tmux`
  setup or teardown.
- Every `ts` fence in a checked README compiles and runs in CI, or quotes a
  tested program under `examples/` via `<!-- runs: examples/... -->`, or states
  why it cannot run via `<!-- static: ... -->`.
- Keep paragraphs to three lines or fewer and omit feature inventories, CI
  matrix narration, and gate boilerplate.
- Close with a `Packages` table and linked package entries (where applicable),
  then short bold-lead bullets under `What it leaves out` and
  `Support and status`.

## Changelogs and release notes

The repository keeps a root `CHANGELOG.md` and one `CHANGELOG.md` per published
package:

- Root `CHANGELOG.md` records product-level release summaries linking each
  package's section, plus cross-package changes (docs, CI, tests, release
  tooling).
- Each package's `CHANGELOG.md` holds that package's changes and inline
  `Before:` / `After:` migrations under `## Unreleased`.
- All release packages share one version, so every package changelog carries a
  heading for every release; a release with no package-specific changes states
  ``No entries for `@libtmux/mcp`.`` under that heading.
- Group entries by component and lead with the literal identifier (`Pane.split`,
  `Selection.one`, `tmux://capabilities`) and a concrete verb.
- Release notes open with a one-paragraph headline and three to five hand-written
  highlights with concrete numbers above any commit list, then link the full
  changelog.

## API documentation

Write TSDoc without restating the type signature. Document what the type system
cannot encode:

- **Mutation, ownership, and lifecycle** — what changes in place, and what the
  caller must close, dispose, or keep alive.
- **Ordering, timing, and concurrency** — result order, what has finished when
  the promise resolves, and whether calls coalesce, queue, or overlap.
- **Failure and cancellation** — `@throws` for every error class and trigger,
  and what an aborted `signal` does to work in flight (`delivery`).
- **Platform and security boundary** — behavior that varies by tmux version or
  OS, and what is executed versus read.

The first sentence stands alone. `@deprecated` names the replacement. For an
enumerated union, document member meanings rather than repeating member names.

`packages/libtmux/docs/api.md` is generated from TSDoc comments; regenerate it
rather than editing by hand:

```console
$ bun run --cwd packages/libtmux docs:api
```

Every public method, getter, and readonly field carries a compiled `ts` example
checked by `typecheck:symbols` and executed by `test:symbols`.

## Source comments

Keep a source comment only when losing it would cost real time rediscovering an
invariant, protocol constraint, upstream tmux quirk, lifetime rule, or subtle
correctness reason that types and tests cannot express. Keep comments to one or
two lines and put design history or rejected alternatives in the commit message.

Delete comments that narrate the next lines, duplicate code-owned counts or
constants, hedge, or reference issue numbers.

Bad (Delete):

```typescript
// There are 321 tests to complete for servers.
```

Good (Keep):

```typescript
// tmux < 3.2 reports the pane ID only after the command completes,
// so this query must stay separate.
```

TSDoc summaries, `@param` / `@returns` / `@throws` tags, and compiled API
examples serve callers and are exempt from the deletion rule above, up to the
length of a concise man page entry.

## Markdown and code blocks

Follow [libtmux/.github `WRITING.md`](https://github.com/libtmux/.github/blob/main/WRITING.md#markdown)
for CommonMark formatting, 80-column repository prose wrapping (tables, badges,
and long URLs excepted), unwrapped PR/issue bodies, and single-command
`console` blocks prefixed with `$ `.

- Use plain CommonMark only: never use GitHub-only alert blocks (`> [!NOTE]`,
  `> [!WARNING]`), which render as literal markers on npmjs.com and external
  renderers.
- Every relative link and `#anchor` across tracked `.md` files is verified by
  `bun run docs:links`, and shell commands, package pins, badges, and
  `<!-- toc -->` blocks are verified by `bun run docs:claims`.

## Commits

Follow the scoped commit format in
[libtmux/.github `WRITING.md`](https://github.com/libtmux/.github/blob/main/WRITING.md#commits-and-pull-requests),
with subjects at 50 characters or fewer (excluding trailing `(#NN)`) and body
lines wrapped at 72 characters:

```text
Pane(feat[sendKeys]): Add support for a literal flag

why: Send characters without tmux interpreting them.

what:
- Add a literal field to SendKeysOptions
- Pass -l when it is set
```

Repository-specific scope conventions in addition to `feat`, `fix`, `refactor`,
`docs`, `chore`, `test`, `style`, and `ci`:

- `js(deps)` and `js(deps[dev])` for runtime and development dependency updates.
- `ai(rules[AGENTS])` for agent rule updates.

### Release commits

Never create tags or push tags; a tag triggers the publish workflow and is
handled by the maintainer. Use `Tag v<version>` as the release commit subject
with `why:` and `what:` in the body.
