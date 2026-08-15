# @libtmux/workspace

**Describe a tmux session as data; apply it. Applying twice converges rather
than duplicating.**

Part of [libtmux for Bun and TypeScript](../../README.md). Built on
[`libtmux`](../libtmux).

> **Status: unreleased.** Not on npm yet; use it from this repository.

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

## License

MIT
