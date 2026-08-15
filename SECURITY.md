# Security

## Reporting a vulnerability

Report privately through
[GitHub's advisory form](https://github.com/libtmux/libtmux-ts/security/advisories/new)
rather than opening an issue. Please include a reproduction and the tmux
version you saw it on.

## Supported versions

Every published version is an alpha prerelease. Fixes land on the newest alpha;
no earlier one is patched. Until `0.1.0` there is no supported release line to
backport to.

## What this package can reach

Worth knowing before you deploy it:

- **It runs a `tmux` binary.** The executable can be chosen by the caller, and
  by `LIBTMUX_TMUX_BIN` in the MCP server. Anything that can set that
  environment variable chooses which program runs.
- **It talks to a tmux socket**, which grants full control of every session on
  that server — including sending keys to a pane that is running something
  privileged. Give an untrusted caller its own socket, never a shared one.
- **`sendKeys` and `cmd` are unsandboxed by design.** They exist to type into a
  terminal and to reach tmux commands this package does not model; treat their
  arguments as you would a shell command.
- **`@libtmux/mcp` hands those capabilities to a model.** An agent with this
  server can execute anything the user running it can execute. Point it at a
  dedicated socket, and do not attach it to the session you work in.

None of this is a vulnerability in itself — it is what a tmux control library
is for. It is listed here because the blast radius is easy to underestimate.
