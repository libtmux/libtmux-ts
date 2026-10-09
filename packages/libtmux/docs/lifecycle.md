# Owned lifetimes and discovery

Borrowed handles leave remote objects alive. `Server.withConnection()` and a connected server's disposal close client transport. `ownSession()`, `ownWindow()`, `ownPane()`, and the adoption functions accept responsibility for remote destruction.

## Scoped creation and failure

The same ordinary program runs against your default endpoint or a harness-supplied `LIBTMUX_SOCKET_PATH`. It includes its imports and uses no fixture code.

```ts
import { Server, ownSession } from "libtmux";

await using session = await ownSession(new Server(), { name: `work-${crypto.randomUUID()}` });
console.log(session.value.id);
```

An owner captures the socket path, PID, start time, generation token, and object ID. Cleanup ignores a body's aborted signal and has a separate 30-second command deadline. Concurrent calls to `dispose()` share one attempt. Successful repeated disposal does nothing; failed disposal retains `state.error` and its transport delivery status. A retry verifies the same generation and, for child resources, checks whether the ID still exists before destroying it. `release()` returns a borrowed handle and disarms cleanup. It refuses while disposal is running or after successful destruction.

`await using` preserves simultaneous body and disposal failures through `SuppressedError`. `withOwned()` offers a callback scope and raises `AggregateError` with the body error first and cleanup error second. Both forms await cleanup after a body failure. They cannot run after process termination; an external fixture must handle timeouts, interruption, or a crashed runner.

```ts
import { Server, ownSession, withOwned } from "libtmux";

const owner = await ownSession(new Server());
try {
  await withOwned(owner, async (session) => {
    console.log(session.id);
    throw new Error("body failed");
  });
} catch (error) {
  console.error(error, owner.state);
  if (owner.state.status === "failed") await owner.dispose();
}
```

The existing borrowed `newSession()`, `newWindow()`, and `split()` APIs keep their creation and readback behavior. The acquisition rollback contract applies to calls returning an owner. Owned creation returns the ID and daemon generation in one tmux invocation. Failed readback, a failed pane identity write, or cancellation after that response triggers rollback against that receipt. `TmuxAcquisitionError` retains the original cause, reports `rolled_back`, `rollback_failed`, or `unknown`, and exposes a failed rollback's `cleanupError` and `retryCleanup()`. An unknown initial reply grants no authority to identify and destroy another client's object by name. An independently owned fixture can recover its daemon; applications must inspect uncertain results before retrying creation.

The library initializes an absent reserved server option, `@libtmux_owner_generation`, with 32 random ASCII hexadecimal characters. It retains an existing valid value and rejects an empty or malformed value. Do not shadow or change that key. The destructive command tests the accepted token and numeric identity inside tmux's command queue, so a replacement daemon cannot satisfy an old owner's guard even when PID and whole-second start time collide. This metadata is an identity guard, not proof that a caller started a daemon.

## Adopting existing objects

`adoptSession(server, "$1")`, `adoptWindow(server, "@2")`, and `adoptPane(server, "%3")` accept the object with that exact ID at the current endpoint. IDs select the object at adoption time; supplying an old handle's ID does not establish that it still identifies the old object. The returned receipt binds later cleanup. Renames and moves cannot redirect it. Killing an owned window destroys all its links and panes; unlinking a placement has different effects.

```ts
import { Server, ownSession, adoptWindow } from "libtmux";

await using session = await ownSession(new Server());
const existing = await session.value.newWindow({ name: "adopted" });
await using window = await adoptWindow(session.value.server, existing.id);
await window.value.rename("renamed");
console.log(window.receipt.id);
```

`adoptServer(server)` accepts destruction of the entire daemon currently answering the endpoint. Use an explicit disposable socket for a whole-server cleanup demonstration. Do not infer server ownership from a lookup or from initializing the generation option.

## Finding or creating resources

Each helper returns `{ created: true, value, owner }` for a confirmed creation or `{ created: false, value }` for reuse. Only a created result carries an owner. A caller can later adopt a reused object with an explicit adoption call.

```ts
import { Server, findOrCreateSession } from "libtmux";

const result = await findOrCreateSession(new Server(), `work-${crypto.randomUUID()}`);
if (result.created) {
  await using owner = result.owner;
  console.log(true, owner.value.id);
} else console.log(false, result.value.id);
```

`findOrCreateSession()` matches an exact name. tmux enforces unique session names; another client winning a creation race can cause a duplicate-name error. `findOrCreateWindow(session, name)` matches an exact window name within that session and rejects multiple matches. `findOrCreatePane(window, { option: "@app_role", value: "worker" })` matches a nonempty application value in a pane user option within that window and rejects multiple matches. Creation writes the pane identity before returning and rolls the pane back if that write fails.

Calls sharing the same supplied parent object serialize within this loaded library instance. Other handles, other module instances, workers, processes, and unrelated tmux clients do not share that queue. External clients can create duplicate window or pane matches, move objects, or observe a new pane before its identity write. The helpers do not claim cross-process atomicity.

`findOrCreateServer()` selects the captured endpoint and uses a random child-environment marker in the startup command queue to distinguish its own startup from a daemon another caller started. A newly started daemon includes an initial session and returns a server owner. An existing daemon remains borrowed even when it had no generation option. A single endpoint has one responding daemon, so this operation has no multiple-match case.

## Bounded local discovery

`discoverServers()` inspects explicit socket directories plus the current user's `/tmp/tmux-UID`, configured `TMUX_TMPDIR/tmux-UID`, and selected endpoint directory. `includeDefaultRoots: false` restricts discovery to explicit roots. It does not recurse. Defaults limit roots to 16, directory entries to 256, probes to 32, each probe to 250 milliseconds, and the whole search to two seconds.

```ts
import { discoverServers } from "libtmux";

const result = await discoverServers({ maxEntries: 64, maxProbes: 8, timeoutMs: 500 });
console.log(result.servers.map((found) => found.socketPath));
console.log(result.diagnostics, result.truncated);
```

Successful entries contain a borrowed server and the daemon identity read by a no-start probe. Root and probe failures retain their errors. Non-socket entries, skipped symlink entries, and duplicate socket device/inode pairs have diagnostics. Root symlinks follow filesystem traversal; `missing/..` still fails and `symlink/..` follows the symlink target's parent. A stale socket produces a failed probe. Results describe only the bounded roots searched, not every tmux daemon on the machine.

A deadline aborts an active probe and stops new work. An outstanding filesystem call can complete later and then close its directory handle; the returned result remains unchanged.

## Example testing boundaries

The repository checks Markdown source excerpts against their included example files, compiles them, and runs the ordinary example unchanged through an external environment. Its Linux fixture checks body failure, cleanup failure, combined failure, timeout, SIGTERM, SIGKILL, and explicit runner exit, then verifies the exact fixture process has exited before deleting its directory. The core transport and emitted declarations retain the declared Bun, Node, and Deno floors.

The shared documentation-testing scope also includes Astro Markdown/MDX, Sphinx reStructuredText/MyST, and Python doctest. Those integrations require native block identities or directive options, source-include resolution, drift checks, doctest expected-output and group-state preservation, and an outer cleanup supervisor. The TypeScript harness does not establish those integrations. Its Markdown markers are one adapter convention rather than a requirement for every documentation format.
