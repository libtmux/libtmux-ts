# @libtmux/workspace

**Describe a tmux session as data; apply it. Applying twice converges rather
than duplicating.**

[![npm](https://img.shields.io/npm/v/@libtmux/workspace?color=cb3837)](https://www.npmjs.com/package/@libtmux/workspace)
[![downloads](https://img.shields.io/npm/dm/@libtmux/workspace?color=cb3837)](https://www.npmjs.com/package/@libtmux/workspace)
[![typescript](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml/badge.svg)](https://github.com/libtmux/libtmux-ts/actions/workflows/typescript.yml)
[![tmux](https://img.shields.io/badge/tmux-3.2a%20%7C%203.7%20%7C%203.7b-1bb91f)](../../.github/workflows/typescript.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Part of [libtmux for Bun and TypeScript](../../README.md). Built on
[`libtmux`](../libtmux).

> [!WARNING]
> **Alpha.** Prerelease software: the config shape and the exported functions
> can change between alpha releases without a deprecation cycle. Pin an exact
> version.

## Install

```console
$ bun add @libtmux/workspace
```

<details>
<summary>npm, pnpm, yarn</summary>

```console
$ npm i @libtmux/workspace
```

```console
$ pnpm add @libtmux/workspace
```

```console
$ yarn add @libtmux/workspace
```

</details>

`libtmux` is a peer of this package in practice: you pass it the `Server`.
Requires Node 22+ or [Bun](https://bun.sh) 1.3.14+, and tmux 3.2a or newer.

## Use it

```ts
import { Server } from "libtmux";
import { applyWorkspace } from "@libtmux/workspace";

const server = new Server();

await applyWorkspace(server, {
  session_name: "api",
  windows: [
    { window_name: "editor", panes: ["vim", "git status"] },
    {
      window_name: "server",
      layout: "even-horizontal",
      panes: [{ shell_command: "bun dev", focus: true }, "bun test --watch"],
    },
  ],
});
```

`applyWorkspace` resolves to the `Session` it built or converged.

## The shape

Config is [tmuxp](https://tmuxp.git-pull.com/)-shaped, so the field names are
the ones people already know — `session_name`, `windows`, `panes`,
`shell_command`, `start_directory`, `layout`, `focus`, `options`.

| Field             | On                      | Effect                                        |
| ----------------- | ----------------------- | --------------------------------------------- |
| `session_name`    | workspace               | The session to build or converge              |
| `start_directory` | workspace, window, pane | Working directory, inherited downward         |
| `options`         | workspace, window       | tmux options set on that scope                |
| `window_name`     | window                  | Renamed if it differs                         |
| `layout`          | window                  | Applied once the pane count settles           |
| `panes`           | window                  | A string is shorthand for `{ shell_command }` |
| `shell_command`   | pane                    | One command or a list, sent in order          |
| `focus`           | window, pane            | Selected last, so the final one wins          |

Because the config is data, it can come from a YAML file, an HTTP request, or a
literal — nothing here parses a format.

## Converging, not just creating

Two details that are easy to get wrong and are handled here:

**No stray leading window.** tmux gives every new session a window and every new
window a pane, so the first of each is adopted rather than created. Creating
them anyway is the classic workspace-builder bug.

**Position, not index.** tmux window indexes are not positions — `base-index`
shifts them and a killed window leaves a gap — so a window is matched by
ordinal.

Applying a workspace against a session that already exists reconciles what is
running with what the file asks for: surplus windows and panes are removed in
one round trip, missing ones created in another.

## A worked example

[`examples/workspace.ts`](../../examples/workspace.ts) builds a session from a
declared layout — a window per concern, panes already running what they are
for, an environment every process inherits, and a teardown that treats "already
gone" as an answer. The integration suite runs it against a real tmux server.

## License

[MIT](LICENSE)
