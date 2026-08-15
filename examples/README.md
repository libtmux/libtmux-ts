# Examples

Each example is executed by the integration suite, so the code here is the code
that runs.

- `quickstart.ts` — acquisition, filtering, relations, pane input, and error
  handling in one pass.
- `watch.ts` — reacting to tmux over control mode: waiting for a window to
  open, and following a pane's output until a marker arrives.
- `agent.ts` — acting and waiting over one control connection: run a command
  until its output arrives, and wait for the server to reach a shape.
- `workspace.ts` — building a session from a declared layout: a window per
  concern, panes already running what they are for, an environment every
  process inherits, and a teardown that treats "already gone" as an answer.
