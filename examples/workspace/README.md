# Workspace

Build the shape most people reach for tmux to get: one session, a window per
concern, each pane already running the thing it is there for.

Two ways to get there, both in [`workspace.ts`](workspace.ts):

- `buildSimpleWorkspace` — a handful of windows, decided in code. Reach for
  this when the layout is fixed and small enough to read in one function.
- `buildWorkspace` — the same shape from a declared `WorkspaceLayout`. Reach
  for this once the windows and panes come from configuration rather than a
  function body, or once there is more than one workspace to build.

`removeWorkspace` tears one down, treating "already gone" as an answer rather
than an error worth propagating.

Part of [libtmux for Bun and TypeScript](../../README.md#is-this-for-you).

## Run it

```console
$ bun install
```

```console
$ bun test examples/workspace
```

The test builds each workspace against a real tmux server the suite starts on
a socket of its own, asserts on the windows and panes it produced, and tears
the server down afterwards. Requires tmux 3.2a or newer.

## The quick way

<!-- runs: examples/workspace/workspace.ts -->

```ts
const built = await server.newSession({
  name: "work",
  shellCommand: "sleep 30",
  windowName: "editor",
});

const [logs, shell] = await server.batch([
  built.plan.newWindow({ name: "logs", shellCommand: "tail -f /dev/null" }),
  built.plan.newWindow({ name: "shell" }),
]);

await logs.selectLayout("even-horizontal");
```

`server.batch` plans every window first and creates them in one invocation, so
this costs one tmux command and one snapshot rather than one round trip per
window.

## The declarative way

`buildWorkspace` takes a `WorkspaceLayout` instead: a name, an environment, and
a list of windows and panes. It reads the first window to name the session,
sends every environment variable, window, and pane as one command pipeline,
then resolves a single snapshot for the result. See
[`workspace.ts`](workspace.ts) for the full function.

This page's first snippet is a literal excerpt of `workspace.ts`, which
`workspace.test.ts` runs against a real tmux server, and which the
[library README](../../packages/libtmux/README.md#recipes) quotes the same
way.

## Where to go next

[`../quickstart/`](../quickstart/README.md) is a shorter tour of the API;
[`../agent.ts`](../agent/README.md) acts on a pane once it exists.
