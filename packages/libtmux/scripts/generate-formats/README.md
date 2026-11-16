# generate-formats

Generates the format-field tables and types from the committed tmux format
fixtures: `src/_generated/*.ts`, `src/field_types.ts`, and the generated `Where` region of
`src/selection.ts`. The library reads those tables to know which tmux format
fields exist, from which version, and what type each holds, so a field is
written down once, in `tests/fixtures/tmux-format-fields.json`.

```console
$ bun run generate
```

```console
$ bun run generate:check
```

`generate` writes the files and `generate:check` fails when they differ from
what the fixtures produce. `build` runs the check first. The command takes
exactly one of `--check` or `--write` and refuses anything else without writing.

The tests check each fixture token, scope and version floor, that the rendering is
deterministic, that check mode detects drift without writing, the generated
`Where` region, and the command's refusals when it runs as a process:

```console
$ bun test packages/libtmux/scripts/generate-formats
```

Run the `bun run` commands from `packages/libtmux` and the tests from the repository root.
