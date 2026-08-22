# Writing

How this project writes prose, for humans and agents alike. It governs
`README.md`, `CHANGELOG.md`, release notes, commit messages, CLI and help text,
error messages, TSDoc, source comments, and migration guides — every surface a
reader reaches.

For building, testing, and pull request workflow, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Voice

Three surfaces, one voice. A doc comment says what a caller may rely on; a
changelog entry says what changed; prose says what happens. All three are
present tense, lead with the thing being described, and stop. Why it was built
that way belongs in the commit message, which is timestamped and attached to
the diff.

The most useful editing operation is deleting the introductory sentence.

Lead with verbs and name concrete things. Put identifiers in backticks. Prefer
short declarative sentences, one operational fact each. Do not explain
TypeScript to TypeScript developers; do explain this project's semantics.

Types describe shape. Documentation describes meaning. A sentence that restates
a signature has said nothing.

Use MUST, SHOULD, and MAY only where the normative sense is meant. Say what
actually happens rather than that something is "supported".

| Instead of                       | Prefer                           |
| -------------------------------- | -------------------------------- |
| "We added…"                      | "`Pane.sendKeys` now supports…"  |
| "New and improved"               | "`Server.sessions` now…"         |
| "powerful", "seamless"           | state the capability             |
| "easily", "simply", "just"       | omit                             |
| "simple", "obvious", "intuitive" | omit                             |
| "robust"                         | name the failure that is handled |
| "comprehensive"                  | name what is covered             |
| "production-ready"               | state the guarantee              |
| "optimized", "blazingly fast"    | give the magnitude               |
| "various fixes"                  | name the components              |
| "under the hood"                 | omit unless observable           |
| "please note that", "note that"  | state the fact                   |
| "leverage", "utilize"            | "use"                            |
| "delve into"                     | "read", or omit                  |
| "best practices"                 | name the practice                |
| "in order to"                    | "to"                             |

## README

A README is the shortest path from "what is this?" to competent use, not the
project's autobiography.

The first sentence is a contract. It says what abstraction the reader has been
handed, concretely enough to tell this package apart from the neighbouring one.
"Typed control of tmux for Bun and TypeScript" is a contract; "a powerful
library for working with terminals" is not.

Get to a runnable command or snippet before anything the reader can skip. A
logo, a mission statement, a comparison matrix and three paragraphs of history
in front of the install line all cost the same thing.

Examples are executable, not illustrative fiction. Never
`your-command <some-options>`. Every snippet on a README page in this
repository is compiled against the tree, and several are executed — see
[Documentation is a gate](CONTRIBUTING.md#the-gates).

Document the semantic model, not the flag list. `--help` already enumerates
flags; what it cannot say is precedence, filesystem effects, what goes to
stdout versus stderr, and what a non-zero exit means.

State defaults explicitly — defaults are API. State negative guarantees where
they exist: "does not modify your `.tmux.conf`", "no network access", "never
touches the server you are attached to". They establish boundaries faster than
any amount of description.

Headings stay conventional and stable, because people deep-link them and
`docs:links` checks the anchors. Badges are few and load-bearing.

## The changelog

A ledger, not a narrative. It is scanned, and the question a reader is asking
is whether an entry affects them, so one change gets one bullet.

Group by the component affected rather than by whether something is a feature
or a fix; a reader arrives knowing which part they use. A component with more
than a handful of entries takes `####` headings for its areas.

Lead with the identifier and a concrete verb — add, fix, remove, deprecate,
support, requires, `now`, `no longer`. Name identifiers literally:
`Server.newSession`, `Selection.one`, `LIBTMUX_TMUX_BUILDS`,
`tmux://panes/{pane}`. One to three sentences.

Do not sell a fix: "no longer returns another command's reply", not "improves
reliability". Do not describe effort. Give the old behaviour only where it
explains a break, and mention mechanism only where a caller can observe it — a
refactor that changes nothing observable is not an entry.

A breaking change ships its migration inline, not a pointer to one. The shape
is change, old, new, reason:

```markdown
`plugins` now accepts package names rather than imported objects.

Before:

    plugins: [eslintPlugin]

After:

    plugins: ["@acme/eslint"]

Configuration can now be read without executing arbitrary modules during
discovery.
```

Entries land under `## Unreleased`. The maintainer assigns the version when
cutting a release, so nothing here predicts one.

## Release notes

The changelog is the permanent ledger; a release page is editorial. Lead with
one paragraph naming the headline change, then three to five highlights, then
link the full changelog.

Numbers over adjectives. "Cold start 41 ms to 6 ms" is a sentence; "much faster
startup" is a smell.

A list of merged commit subjects is a merge log wearing a release-note hat. Put
the hand-written highlights above it.

## API documentation

TSDoc, and the prime directive: never restate the type. The signature is the
source of truth; the comment carries what the signature cannot.

This is documentation debt wearing a doc comment:

```typescript
/**
 * Gets the pane's identifier.
 * @param pane - The pane.
 * @returns The identifier.
 */
```

Document instead the dimensions the type system cannot encode:

- **Mutation.** What it changes in place.
- **Ownership.** What the caller must close, dispose, or keep alive.
- **Ordering.** Whether results come back in a guaranteed order.
- **Timing.** What has finished by the time the promise resolves.
- **Failure.** Which errors are thrown and what triggers each.
- **Idempotence.** Whether calling twice does anything the second time.
- **Concurrency.** Whether calls are coalesced, queued, or independent.
- **Cancellation.** What an aborted signal does to work in flight.
- **Platform.** Behaviour that differs by tmux version or by OS.
- **Security boundary.** What is executed, and what is only read.

The first sentence stands alone; tooling truncates there. Use `@throws`
generously, because TypeScript has no typed exceptions and it is the only way a
caller learns to catch. `@deprecated` names the replacement.

For an enumerated union, document the meanings rather than repeating the
members — the type already lists them.

`packages/libtmux/docs/api.md` is generated from the doc comments that
implement it. Never edit it by hand:

```console
$ bun run docs:api
```

Every public method, getter, and readonly field carries a compiled example. A
signature with no example fails `typecheck:symbols`, and one that no longer
compiles fails it too.

## Source comments

A comment ships only if it passes all three gates. Fail any: delete or rewrite.
Borderline: delete — borderline means the information is reconstructible, which
is what makes deletion cheap.

**Loss.** Three years from now, would losing this cost a maintainer real time
rediscovering intent, an invariant, a constraint, or a failure mode the code and
tests do not already make obvious?

**Elite.** Would SQLite, Redis, the Go standard library, or CPython write this
comment, at this length? Those projects state the constraint and stop. They do
not argue with an imagined objector.

**Upkeep.** Will it stay true without maintenance? A comment that hand-syncs a
value the code owns — a count, an offset, a line reference, a duplicated
constant — is false the first time that value moves.

### Ceiling

One or two lines. A comment reaching four is either carrying several facts, in
which case split it, or arguing, in which case cut it to the fact.

Rationale, alternatives weighed, and the story of how the code got here belong
in the commit message: timestamped, attached to the exact diff, and free to
maintain.

A comment often holds both a constraint and the deliberation that found it. Keep
the constraint, cut the deliberation. "Runs at most once per second" survives;
"this is the right trade for now" does not.

### Keep

- Why over how: upstream quirks, protocol and compatibility constraints,
  performance tradeoffs still part of the contract.
- Invariants, preconditions, ordering, lifetime, and concurrency requirements
  that types and tests cannot express.
- Code that looks wrong but is not, so a later cleanup does not reintroduce the
  bug.
- A high-level sketch of an algorithm whose local operations do not reveal the
  whole.

### Delete

- Narration of the next lines; code translated into English.
- Restated names, types, defaults, or control flow.
- Values duplicated from the code and hand-synced.
- Justification, hedging, or apology for a choice.
- Speculation about future requirements.
- History version control already holds, including commented-out code.
- Ticket and issue numbers. They say nothing to a reader without tracker access,
  and they rot when the tracker moves. Unfinished work goes in the tracker, not
  the source.
- Transient observations — "currently", "for now", "the latest release" —
  that go stale with no nearby edit.

### The upkeep gate in practice

It reaches values that track our own code. It does not reach frozen external
facts.

Bad (Delete):

```typescript
// There are 321 tests to complete for servers.
```

Good (Keep):

```typescript
// tmux < 3.2 reports the pane ID only after the command completes,
// so this query must stay separate.
```

### Documentation exception

Minimal usage examples, and param, return, and throws lines on public API are
exempt from the loss gate — they serve the caller, not the maintainer. They are
exempt from nothing else. Ceiling: a good man page entry.

TSDoc summaries, `@param` and `@returns` tags, and the compiled examples fall
under this exception.

## Terminology and capitalization

Pick the domain noun and keep it. If the code calls something a session, do not
call it a workspace in one paragraph and an environment in the next. If the
method is `capturePane`, write "capture" everywhere rather than alternating
with "read", "grab", and "snapshot" — snapshot means something else here.

Stable vocabulary is what makes search, deep links, and an agent's retrieval
work at all.

`tmux` is lowercase, always, including at the start of a sentence — rewrite the
sentence rather than capitalising it. TypeScript, Bun, and Node keep their own
capitalisation.

Do not write counts into prose — how many symbols are ported, how many fields a
version is asked for. They go stale silently and no reader needs them. Counts
that pin a fixture or guard an invariant are different, and belong in code.

## Markdown

Prose wraps at 80 columns. Table rows, badge lines, and long links are exempt,
because breaking them harms rendering. A pull request or issue body does not
wrap at all: GitHub renders a single newline as a space in a file and as a line
break in a comment, so a wrapped comment body arrives as ragged stubs.

Tables, badges, and links are fine everywhere.

GitHub alert blocks — `> [!NOTE]`, `> [!WARNING]` — render as literal text
outside GitHub, so reserve them for at most one load-bearing warning per
document. The alpha warning in the root README is that one. Write the sentence
so it carries the fact on its own, and a renderer that drops the marker loses
nothing.

Every relative link and `#anchor` in every tracked Markdown file is checked by
`docs:links`, so a heading rename breaks the links that point at it.

## Code blocks

Code blocks are paste-and-run units: pasting one block runs exactly one intended
action. Executed examples are exempt — the test suite runs them, nobody pastes
them.

- **One command per block.** Multiple steps may share a block only when
  explicitly chained with `&&`, `;`, or `\` continuations — the chain is then
  one logical command.
- **Explanations go in prose above the block**, never as `#` comments inside it.
- **Command menus are per-command blocks with prose lead-ins**, not tables.
- **Shell commands use the `console` tag with a `$ ` prefix.** This separates
  interactive commands from scripts and enables prompt-aware copy.
- **Split long commands with `\`** — one flag or flag+value pair per indented
  continuation line, positional arguments last.

Good — show the last ten commits as a graph:

```console
$ git log \
    --max-count=10 \
    --graph \
    --oneline
```

Bad:

```console
# Show the last ten commits as a graph
$ git log --max-count=10 --graph --oneline
```

## Commits

```
Scope(type[detail]): concise description

why: Explanation of necessity or impact.

what:
- Specific technical changes made
- Focused on a single topic
```

Keep the subject to 50 characters or fewer, excluding any trailing `(#NN)` pull
request reference, and wrap body lines at 72. Separate the `why:` and `what:`
blocks with a blank line.

Common types:

- **feat**: New features or enhancements
- **fix**: Bug fixes
- **refactor**: Code restructuring without functional change
- **docs**: Documentation updates
- **chore**: Maintenance (dependencies, tooling, config)
- **test**: Test-related updates
- **style**: Code style and formatting
- **ci**: Workflow and pipeline changes
- **js(deps)**: Dependencies
- **js(deps[dev])**: Dev dependencies
- **ai(rules[AGENTS])**: AI rule updates

Example:

```
Pane(feat[sendKeys]): Add support for a literal flag

why: Send characters without tmux interpreting them.

what:
- Add a literal field to SendKeysOptions
- Pass -l when it is set
```

For a multi-line message, use a heredoc so the formatting survives:

```console
$ git commit -m "$(cat <<'EOF'
Scope(feat[detail]): Concise description

why: Explanation of the change.

what:
- First change
- Second change
EOF
)"
```

### Release commits

Never create tags. Never push tags. The owner handles tagging and tag pushes,
because a tag triggers the publish workflow.

A release commit subject is plain and short: `Tag v<version>`. The detailed why
and what go in the body. Do not use the `Scope(type[detail]):` format for a
release — it buries the lede.

## Slop prevention

Treat AI slop as review-hostile noise, not as proof that text or code is wrong.
The goal is to maximise information density.

- **AI signatures.** No "Generated by", no conversational filler, no
  unexplained emoji, no tool metadata.
- **Brittle references.** No hard-coded line numbers, fragile file counts, dated
  "as of" claims, bare SHAs, or local absolute paths — unless they are strict
  evidentiary artefacts such as a benchmark log.
- **Diff narration.** Do not restate what moved, was renamed, or was removed in
  anything the reader holds alongside the diff: code, doc comments, README, or
  a pull request description. The diff and the commit message already carry it.
- **Branch-internal narrative.** Do not mention intermediate states, abandoned
  approaches, or "no longer" behaviour unless users of a published release
  actually experienced the old state.
- **Low-value scaffolding.** No ownerless TODOs, unused future-proofing, debug
  artefacts, or defensive wrappers around failure modes nothing can reach.
- **Prose inflation.** The diction table under [Voice](#voice) governs; replace
  an inflated word with a concrete description of behaviour, constraints, or
  trade-offs.
- **Coded labels.** Write rules and findings as plain imperatives. No `[R1]`,
  `Option B`, or any index a reader has to decode.

Preserve the "why". Never delete a comment documenting an invariant, a protocol
constraint, a platform quirk, or an upstream workaround — those are the facts
[Source comments](#source-comments) keeps, and every other comment is judged by
it.
