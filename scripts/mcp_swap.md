# Native MCP swap helper

`mcp_swap.ts` points selected agent clients at this repository's MCP server and
then restores the exact configuration that preceded the swap. It is a private
contributor tool, not an end-user configuration manager or a published package.
The [MCP guide](../packages/mcp/README.md) documents the server itself; the
[security policy](../SECURITY.md) defines its authority boundary.

The helper supports Claude, Codex, Cursor, Gemini, Grok, Antigravity (`agy`),
opencode, and pi in one deterministic transaction. It edits only the selected
server entry. Unrelated keys, JSONC comments, TOML tables, file modes, and
symlink routes remain intact.

## Sources

`--source` chooses what every selected client launches:

| Source      | Registered command                      | Use it for                                    |
| ----------- | --------------------------------------- | --------------------------------------------- |
| `dev`       | Bun plus `packages/mcp/src/server.ts`   | Running current TypeScript without rebuilding |
| `build`     | Node plus `packages/mcp/dist/server.js` | Exercising the compiled package shape         |
| `published` | `npx -y @libtmux/mcp@VERSION`           | Reproducing a registry release or dist-tag    |

`dev` is the default. A live `build` swap builds `packages/mcp` before the MCP
probe. A published probe lets `npx` resolve the requested package before any
configuration is changed. `--dry-run` performs neither step.

## Inspect first

Report the executable and known configuration path for all eight clients:

```console
$ bun scripts/mcp_swap.ts detect
```

A client is detected for default `use` selection only when both its executable
and its known configuration exist. An explicit `--cli` selection may create a
missing configuration. pi also reports whether `pi-mcp-adapter` is present;
pi has no built-in MCP client.

Show the current registration without changing it:

```console
$ bun scripts/mcp_swap.ts status
```

Claude status shows both `claude:user` and `claude:project`. Restrict it to the
selected repository's project layer when that distinction matters:

```console
$ bun scripts/mcp_swap.ts status --scope project
```

Run read-only configuration and recovery diagnostics:

```console
$ bun scripts/mcp_swap.ts doctor
```

`doctor` parses existing configuration, authenticates outstanding TypeScript
recovery state, reports unowned TypeScript backup files, and names environment
variables that override a client's stored login. It never prints those values.

## Preview and use

Validate every detected client without building, starting a server, acquiring
the mutation lock, or writing a file:

```console
$ bun scripts/mcp_swap.ts use --source dev --dry-run
```

Point the detected clients at the live TypeScript source:

```console
$ bun scripts/mcp_swap.ts use --source dev
```

Build once, probe the compiled server, and register the built JavaScript:

```console
$ bun scripts/mcp_swap.ts use --source build
```

Probe and register a pinned published release:

```console
$ bun scripts/mcp_swap.ts use --source published --version 0.1.0-alpha.7
```

Pass `--cli` more than once or use comma-separated names. Selections are
deduplicated into the fixed eight-client transaction order. `antigravity` is
an alias for `agy`.

```console
$ bun scripts/mcp_swap.ts use --cli cursor,pi --cli antigravity --env LIBTMUX_TOOLSETS=inspect,manage
```

Existing entry environment is retained, and explicit `--env KEY=VALUE` values
win. `LIBTMUX_SAFETY` is retired and cannot be supplied. An inherited
`LIBTMUX_SAFETY` value remains unchanged unless the request explicitly supplies
`LIBTMUX_TOOLSETS`; that explicit replacement is the only condition under which
the helper removes the retired value.

`--no-preflight` is available for deliberate offline work. It skips the MCP
handshake, not configuration validation or a required local build.

## Claude scopes

Claude stores two supported layers in `~/.claude.json`:

- `project`, the default for `use`, writes only
  `projects.<absolute-repository>.mcpServers`.
- `user` writes the top-level `mcpServers` fallback.

Other clients normalize either scope to `user` because their known global
configuration has no equivalent layered node.

Both Claude layers may coexist. Their first backups remain independent even
though they share one file. A scoped revert cannot skip a newer layer in that
file.

```console
$ bun scripts/mcp_swap.ts use --scope user --cli claude
```

```console
$ bun scripts/mcp_swap.ts use --scope project --cli claude
```

Without `--scope`, revert restores every recorded selected layer in strict
reverse swap order:

```console
$ bun scripts/mcp_swap.ts revert
```

Use a scope only when reverting that layer does not cross a newer one:

```console
$ bun scripts/mcp_swap.ts revert --scope project --cli claude
```

## Configuration boundaries

The helper owns one known global file per client:

| Client      | Configuration                              | Format and server map                             |
| ----------- | ------------------------------------------ | ------------------------------------------------- |
| Claude      | `~/.claude.json`                           | JSON `mcpServers`, plus the selected project node |
| Codex       | `~/.codex/config.toml`                     | TOML `mcp_servers`                                |
| Cursor      | `~/.cursor/mcp.json`                       | JSON `mcpServers`                                 |
| Gemini      | `~/.gemini/settings.json`                  | JSON `mcpServers`                                 |
| Grok        | `~/.grok/config.toml`                      | TOML `mcp_servers`                                |
| Antigravity | `~/.gemini/config/mcp_config.json`         | JSON `mcpServers`                                 |
| opencode    | `$XDG_CONFIG_HOME/opencode/opencode.jsonc` | JSONC `mcp`                                       |
| pi          | `~/.pi/agent/mcp.json`                     | JSONC `mcpServers` for `pi-mcp-adapter`           |

Malformed UTF-8, ambiguous duplicate containers, wrong container types,
invalid server entry fields, and malformed JSON, JSONC, or TOML fail closed.
The helper does not walk project-local Cursor, Gemini, or opencode files. Use
those clients' native configuration commands when project precedence is the
behavior under test.

opencode may merge several global filenames. This helper owns
`opencode.jsonc`, the file opencode itself writes; an entry in another merged
file can still contribute underneath it.

## Preflight and transaction safety

Before a live write, the helper builds or resolves the source, then launches
every distinct final command and environment. The probe requires a JSON-RPC
2.0 response with the initialize request ID, an object result, and a nonempty
`protocolVersion`. A server may remain alive after replying; the probe accepts
the response and promptly terminates and reaps the complete process group.
Timeouts and aggregate stdout or stderr overflow do the same.

Only after all probes pass does mutation begin. Every language port serializes
through the same blocking POSIX record lock:

`$XDG_STATE_HOME/libtmux-mcp-dev/swap/state.lock`

The lock owner is a dedicated Bun process. This keeps the POSIX lock isolated
from configuration and recovery descriptors opened by the parent. The worker
authenticates its descriptor against the live lock path and releases on normal
completion or parent-pipe closure.

Under the lock, the helper replans the final command and environment and
requires them to match the preflighted specifications exactly. It then stages
all outputs and authenticates paths again before the first publication. A
late path, inode, mode, content, symlink, or hardlink change aborts rather than
overwriting an object the transaction did not plan.

## Recovery

TypeScript recovery is intentionally separate from every other port:

- State is a versioned, checksummed 0600 ledger under
  `$XDG_STATE_HOME/libtmux-mcp-dev/swap/typescript/`.
- Backup filenames contain `.bak.mcp-swap-typescript-` and a monotonic sequence.
- The ledger records client and scope ownership, the original mode and route,
  SHA-256 content digests, file identities, and the expected current config.

The first backup for a layer is retained across repeat swaps. Reverting
therefore returns to the bytes and mode from before the first swap, not merely
the preceding server command. A repeat swap of an older Claude layer rewrites
the newer layer's recovery link in the chain so unscoped LIFO restoration still
lands on the original file.

The native command does not infer or import Python or legacy sidecars. If
recovery authentication fails, inspect the reported files and use `doctor`;
an unowned backup may be the only surviving pre-swap copy.

The POSIX lock implementation targets Linux and macOS. The automated native
transaction suite exercises Linux and does not establish macOS behavior.
Windows is rejected because this helper has no compatible record-lock backend.

## Development checks

Run the focused swap and bounded-process tests:

```console
$ bun test packages/libtmux/tests/unit/mcp_swap.test.ts packages/libtmux/tests/unit/bounded_process.test.ts
```

Check the repository tooling types:

```console
$ bun run typecheck:tooling
```

Check formatting and lint before committing:

```console
$ bun run format:check
```

```console
$ bun run lint
```

All mutation tests replace `HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME`
with temporary roots. They must never inspect or write live client
configuration.
