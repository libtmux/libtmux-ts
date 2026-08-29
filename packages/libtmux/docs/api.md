# API reference

Every entry is generated from the source that implements it, and every
example here is compiled against the package on each run — `bun run
typecheck:symbols` is what keeps that true.

Start with the [README](../README.md) for a reading order and recipes; this
page is for looking one thing up.

## Server

[`open`](#serveropen) · [`withConnection`](#serverwithconnection) · [`colors`](#servercolors) · [`configFile`](#serverconfigfile) · [`socketName`](#serversocketname) · [`socketPath`](#serversocketpath) · [`engine`](#serverengine) · [`tmuxBin`](#servertmuxbin) · [`watch`](#serverwatch) · [`connect`](#serverconnect) · [`snapshot`](#serversnapshot) · [`sessions`](#serversessions) · [`windows`](#serverwindows) · [`panes`](#serverpanes) · [`daemonIdentity`](#serverdaemonidentity) · [`clients`](#serverclients) · [`showOptions`](#servershowoptions) · [`showResolvedOptions`](#servershowresolvedoptions) · [`setOption`](#serversetoption) · [`unsetOption`](#serverunsetoption) · [`saveBuffer`](#serversavebuffer) · [`showGlobalOptions`](#servershowglobaloptions) · [`setGlobalOption`](#serversetglobaloption) · [`unsetGlobalOption`](#serverunsetglobaloption) · [`showHooks`](#servershowhooks) · [`setHook`](#serversethook) · [`unsetHook`](#serverunsethook) · [`version`](#serverversion) · [`versionAtLeast`](#serverversionatleast) · [`showEnvironment`](#servershowenvironment) · [`getEnvironment`](#servergetenvironment) · [`setEnvironment`](#serversetenvironment) · [`unsetEnvironment`](#serverunsetenvironment) · [`removeEnvironment`](#serverremoveenvironment) · [`newSession`](#servernewsession) · [`kill`](#serverkill) · [`hasSession`](#serverhassession) · [`sourceFile`](#serversourcefile) · [`listCommands`](#serverlistcommands) · [`loadBuffer`](#serverloadbuffer) · [`setBuffer`](#serversetbuffer) · [`showBuffer`](#servershowbuffer) · [`showBufferBytes`](#servershowbufferbytes) · [`listBuffers`](#serverlistbuffers) · [`deleteBuffer`](#serverdeletebuffer) · [`runShell`](#serverrunshell) · [`ifShell`](#serverifshell) · [`isAlive`](#serverisalive) · [`raiseIfDead`](#serverraiseifdead) · [`cmd`](#servercmd) · [`pipeline`](#serverpipeline) · [`batch`](#serverbatch)

### Properties

#### `Server.colors`

```ts
get colors(): 88 | 256 | undefined
```

How many colours this server was told the terminal has.

```ts
new Server({ colors: 256 }).colors; // 256
```

#### `Server.configFile`

```ts
get configFile(): string | undefined
```

The configuration file this server was pointed at, if any.

```ts
new Server({ configFile: "~/.tmux.conf" }).configFile;
```

```ts
new Server({ configFile: "~/.tmux.conf" }).configFile;
```

#### `Server.socketName`

```ts
get socketName(): string | undefined
```

The socket name this server addresses, if it was named rather than pathed.

```ts
new Server({ socketName: "work" }).socketName; // "work"
```

```ts
new Server({ socketName: "work" }).socketName; // "work"
```

#### `Server.socketPath`

```ts
get socketPath(): string | undefined
```

The socket path this server addresses, if it was given one.

```ts
new Server({ socketPath: "/tmp/tmux-1000/work" }).socketPath;
```

```ts
new Server({ socketPath: "/tmp/tmux-1000/work" }).socketPath;
```

#### `Server.engine`

```ts
get engine(): TmuxEngine | undefined
```

The engine this server was built with, if it was given one.

`undefined` means tmux is a process this one can spawn, which is what
{@link Server.watch} and {@link Server.connect} need and what a caller
choosing between a connection and a command per read has to know.

```ts
const reader = server.engine === undefined ? await server.connect() : server;
(await reader.snapshot()).windows.count();
```

#### `Server.tmuxBin`

```ts
get tmuxBin(): string
```

The tmux executable this server runs.

```ts
new Server().tmuxBin; // "tmux"
```

```ts
new Server().tmuxBin; // "tmux"
```

### Methods

#### `Server.open`

```ts
static async open(options?: ServerOptions): Promise<ManagedServer>
```

Build a server with its transport already chosen.

The same API either way: what changes is whether a command spawns a process
or travels over a connection this holds open. The mode comes from
`transport`, or from `LIBTMUX_TRANSPORT` when that is not set — so a script
can be pointed at a connection without editing it, and a test can force
either mode around code that names neither.

Asynchronous because attaching is: a control connection has to reach tmux
before it can carry anything, and a server with no sessions has nothing to
attach to. `close` is safe on both, and does nothing on a spawning server.

```ts
await using managed = await Server.open({ transport: "control" });
(await managed.snapshot()).sessions.count();
```

#### `Server.withConnection`

```ts
async withConnection<T>( body: (live: ConnectedServer) => Promise<T>, options?: ConnectOptions, ): Promise<T>
```

Run `body` against a connected server, closing it afterwards.

The scoped form of {@link connect}, for code that cannot use `await using`
— it needs `Symbol.asyncDispose` in the consumer's `lib` — or would rather
not manage the lifetime by hand. The connection closes on the way out
whether `body` returns or throws.

```ts
const opened = await server.withConnection(async (live) => {
  await session.newWindow({ name: "build" });
  return live.waitFor((current) => current.windows.exists({ name: "build" }));
});
opened.windows.count({ name: "build" }); // 1
```

#### `Server.watch`

```ts
watch(options?: WatchOptions): TmuxEventStream
```

Stream tmux's control-mode notifications until the stream is disposed.

A snapshot answers what is true now; this answers what changed. The stream
holds one `tmux -C attach-session` process for its lifetime, so it reports
events without polling and without a command per read.

tmux sends a control client no pane output until it attaches, so this
attaches to a session; a server with no sessions has nothing to watch.

Name that session with `target` when reading pane output. Structural
notifications reach the client wherever it attached, but output arrives
only for the attached session, and an untargeted watch lands on whichever
session tmux considers current. With two sessions on the server that is
silence rather than an error.

```ts
await using events = server.watch();
for await (const event of events) {
  if (event.kind === "window-add") console.log(event.windowId);
}
```

#### `Server.connect`

```ts
async connect(options?: ConnectOptions): Promise<ConnectedServer>
```

Bind this server to one control-mode connection and return it.

The returned server has the same API, but its commands travel over an
already-open connection instead of spawning a `tmux` process each. A
snapshot costs four writes rather than four processes, which is what makes
reacting to {@link watch} events affordable in a loop.

Operations that need stdin or exact bytes use a spawned command against
the same socket because control mode has no channel for either.

```ts
await using live = await server.connect();
for await (const event of live.subscribe()) {
  if (event.kind === "window-add") console.log((await live.snapshot()).windows.count());
}
```

#### `Server.snapshot`

```ts
snapshot(): Promise<ServerSnapshot>
```

Acquire an immutable view of the server at this instant.

Acquisition is the only step that talks to tmux. Everything reachable from
the returned value resolves locally, so traversal and filtering issue no
commands and an earlier snapshot keeps reporting its own instant.

```ts
const now = await server.snapshot();
now.windows.count();
```

#### `Server.sessions`

```ts
async sessions(): Promise<Selection<Session>>
```

Every session on the server, read now.

This and its three siblings each take a snapshot of their own — four tmux
commands per call — so calling several in a row describes several different
instants and pays for each. Inside a loop that is an N+1: prefer one
{@link snapshot} and read `sessions`, `windows`, `panes`, and `clients`
off it, which is both cheaper and consistent.

```ts
const sessions = await server.sessions();
sessions.where({ name: "work" }).count();
```

```ts
// Four commands, and every collection agrees with the others.
const now = await server.snapshot();
for (const session of now.sessions) console.log(session.name, session.windows.length);
```

#### `Server.windows`

```ts
async windows(): Promise<Selection<Window>>
```

Every window on the server, including each placement of a linked window.

```ts
const windows = await server.windows();
windows.first()?.name;
```

#### `Server.panes`

```ts
async panes(): Promise<Selection<Pane>>
```

Every pane on the server.

```ts
const panes = await server.panes();
panes.where({ currentCommand: "vim" }).count();
```

#### `Server.daemonIdentity`

```ts
async daemonIdentity(): Promise<DaemonIdentity | undefined>
```

Which daemon is answering on this socket right now.

A socket path names a place, not a process. `kill-server` followed by a
restart puts a different daemon at the same path, and that daemon numbers
its panes from `%0` again — so a handle held across the restart names an
object that no longer exists, at an id something else now has. Comparing
this before and after is how a long-running caller can tell.

`undefined` when the server has nothing to list, which is also the only
case where it has handed out no handles to invalidate.

```ts
const before = await server.daemonIdentity();
const after = await server.daemonIdentity();
before?.pid === after?.pid;
```

#### `Server.clients`

```ts
async clients(): Promise<Selection<Client>>
```

Every client attached to the server.

```ts
const clients = await server.clients();
clients.map((entry) => entry.tty);
```

#### `Server.showOptions`

```ts
showOptions(): Promise<ReadonlyMap<string, string>>
```

Every server-scope option tmux currently reports.

```ts
const options = await server.showOptions();
options.get("escape-time");
```

#### `Server.showResolvedOptions`

```ts
showResolvedOptions(): Promise<ReadonlyMap<string, string>>
```

The option values that govern this server, own and inherited together.

`showOptions` reports only what was set here, which for a fresh server is
often nothing. This resolves what it inherits as well, so an option has an
answer wherever it was actually set.

```ts
(await server.showResolvedOptions()).get("message-limit");
```

#### `Server.setOption`

```ts
setOption(name: string, value: string, options?: SetOptionOptions): Promise<void>
```

Set a server-scope option.

```ts
await server.setOption("escape-time", "0");
```

#### `Server.unsetOption`

```ts
unsetOption(name: string): Promise<void>
```

Remove a server-scope option.

```ts
await server.unsetOption("escape-time");
```

#### `Server.saveBuffer`

```ts
saveBuffer(name: string, path: string, options?: { readonly append?: boolean }): Promise<void>
```

Write a paste buffer to a file instead of reading it back.

`showBuffer` returns the contents through this process; for a large buffer
that means holding it in memory to put it somewhere else. tmux writes the
file itself, on the machine tmux is running on.

```ts
await server.saveBuffer("captured", "/tmp/build.log");
```

#### `Server.showGlobalOptions`

```ts
showGlobalOptions(scope: "session" | "window"): Promise<ReadonlyMap<string, string>>
```

Read the defaults every session or window inherits.

Most of tmux's options live here rather than on an object: a session that
has set nothing reports nothing, while the values actually governing it
are these. `history-limit` and `default-shell` are both global session
options and `remain-on-exit` a global window one; none of the three is
readable any other way.

```ts
const defaults = await server.showGlobalOptions("session");
defaults.get("default-shell");
```

#### `Server.setGlobalOption`

```ts
setGlobalOption( scope: "session" | "window", name: string, value: string, options?: SetOptionOptions, ): Promise<void>
```

Set a default every session or window inherits.

```ts
await server.setGlobalOption("session", "history-limit", "50000");
```

#### `Server.unsetGlobalOption`

```ts
unsetGlobalOption(scope: "session" | "window", name: string): Promise<void>
```

Remove a default, so tmux falls back to its own built-in value.

```ts
await server.unsetGlobalOption("session", "history-limit");
```

#### `Server.showHooks`

```ts
showHooks(): Promise<ReadonlyMap<string, readonly string[]>>
```

Every global hook tmux currently reports.

A hook is an array of commands, keyed by the name `setHook` takes, so
what was set reads back under the name it was set with. tmux prints each
element as `name[0]`, which composes with neither of the writers.

```ts
const hooks = await server.showHooks();
hooks.get("session-created")?.[0];
```

#### `Server.setHook`

```ts
setHook(name: string, command: string, options?: SetHookOptions): Promise<void>
```

Bind a tmux command to a global hook.

A hook holds a list of commands. Without `append` this writes the whole
list, so it replaces whatever the hook already ran.

```ts
await server.setHook("session-created", "display-message 'hello'");
await server.setHook("session-created", "display-message 'and this'", { append: true });
```

#### `Server.unsetHook`

```ts
unsetHook(name: string): Promise<void>
```

Remove a global hook.

```ts
await server.unsetHook("session-created");
```

#### `Server.version`

```ts
async version(): Promise<TmuxVersion>
```

The tmux version this server is running.

The version is probed once per connection and cached with the rest of the
server's capabilities, so asking repeatedly costs nothing after the first.

```ts
const version = await server.version();
version.major; // 3
```

#### `Server.versionAtLeast`

```ts
async versionAtLeast(minimum: string): Promise<boolean>
```

Whether this server is at least `minimum`, written the way tmux writes it.

This is how a caller gates on a feature that arrived in a known release
without parsing `#{version}` themselves. A `master` build compares above
every tagged release.

```ts
if (await server.versionAtLeast("3.3")) {
  await server.setOption("extended-keys", "on");
}
```

#### `Server.showEnvironment`

```ts
showEnvironment(): Promise<ReadonlyMap<string, EnvironmentValue>>
```

Every variable in the server's global environment.

A `null` value is tmux's `-NAME`: present, and marked for removal from any
process tmux starts.

```ts
const environment = await server.showEnvironment();
environment.get("EDITOR");
```

#### `Server.getEnvironment`

```ts
getEnvironment(name: string): Promise<EnvironmentValue | undefined>
```

One variable from the server's global environment, or `undefined` when tmux carries no entry.

```ts
await server.getEnvironment("EDITOR"); // "vim", null, or undefined
```

#### `Server.setEnvironment`

```ts
setEnvironment(name: string, value: string, options?: SetEnvironmentOptions): Promise<void>
```

Set a variable in the server's global environment.

```ts
await server.setEnvironment("EDITOR", "vim");
```

#### `Server.unsetEnvironment`

```ts
unsetEnvironment(name: string): Promise<void>
```

Drop a variable from the server's global environment entirely.

```ts
await server.unsetEnvironment("EDITOR");
```

#### `Server.removeEnvironment`

```ts
removeEnvironment(name: string): Promise<void>
```

Mark a variable in the server's global environment for removal from the environment of processes
tmux starts, leaving the entry in place.

```ts
await server.removeEnvironment("EDITOR");
```

#### `Server.newSession`

```ts
newSession(options?: NewSessionOptions): Promise<Session>
```

Create a detached session and resolve it as a handle.

```ts
const created = await server.newSession({ name: "work" });
created.name; // "work"
```

#### `Server.kill`

```ts
kill(): Promise<void>
```

Terminate the tmux server and every session on it.

```ts
await server.kill();
```

#### `Server.hasSession`

```ts
hasSession(name: string): Promise<boolean>
```

Whether a session with this name exists.

The name is matched exactly. tmux normally accepts a unique prefix as a
session target, which would make checking `work` answer yes for
`workspace`; this method does not.

```ts
if (!(await server.hasSession("work"))) {
  await server.newSession({ name: "work" });
}
```

#### `Server.sourceFile`

```ts
sourceFile(path: string): Promise<void>
```

Run a tmux config file against this server.

tmux does not expand `~` here. `source-file` joins a path that is not
absolute to the client's working directory and globs the result, so
`"~/.tmux.conf"` looks for a directory literally named `~`. Typing it at a
shell works because the shell expands it first; passing it as a string
never does.

```ts
await server.sourceFile(`${process.env["HOME"] ?? "."}/.tmux.conf`);
```

#### `Server.listCommands`

```ts
listCommands(): Promise<readonly string[]>
```

Every command name the running tmux understands.

```ts
const commands = await server.listCommands();
commands.includes("new-window"); // true
```

#### `Server.loadBuffer`

```ts
loadBuffer(name: string, data: string | Uint8Array): Promise<void>
```

Fill a paste buffer from data fed through tmux's stdin.

Use this over {@link Server.setBuffer} for anything large or binary: that
one passes its data as a command-line argument, and this one does not.
Control mode has no channel for stdin, so this needs the spawning server.

```ts
await server.loadBuffer("payload", new Uint8Array([0x68, 0x69]));
```

#### `Server.setBuffer`

```ts
setBuffer(name: string, data: string): Promise<void>
```

Put a string into a named paste buffer.

Empty data stores nothing. tmux exits zero for `set-buffer -b name ""` and
creates no buffer at all, so the name a caller thinks they just wrote is
absent — and they learn that from whatever reads it next, which points at
the wrong call. Check before storing content that may be empty.

```ts
await server.setBuffer("greeting", "hello");
```

#### `Server.showBuffer`

```ts
showBuffer(name: string): Promise<readonly string[]>
```

Read a named paste buffer's contents.

Over a control connection this stops at the first NUL byte: tmux writes a
command's output to a control client as a C string. The buffer is unharmed
— `saveBuffer` and a spawning server both read it whole — and a pane's own
output is unaffected, being escaped before it is written.

```ts
const lines = await server.showBuffer("greeting");
lines[0]; // "hello"
```

#### `Server.showBufferBytes`

```ts
showBufferBytes(name: string): Promise<Uint8Array>
```

Read a named paste buffer without decoding or splitting its bytes.

Unlike {@link Server.showBuffer}, this preserves NUL, invalid UTF-8, line
endings, and trailing newlines. A connected server runs this read through
the spawning transport because tmux control mode cannot carry those bytes.

```ts
const bytes = await server.showBufferBytes("payload");
bytes[0]; // 104
```

#### `Server.listBuffers`

```ts
listBuffers(): Promise<readonly string[]>
```

Every buffer name this server holds.

```ts
const names = await server.listBuffers();
names.length;
```

#### `Server.deleteBuffer`

```ts
deleteBuffer(name: string): Promise<void>
```

Discard a named paste buffer.

```ts
await server.deleteBuffer("greeting");
```

#### `Server.runShell`

```ts
runShell(command: string, options?: RunShellOptions): Promise<readonly string[]>
```

Run a shell command through tmux and return whatever it printed.

```ts
const lines = await server.runShell("echo hello");
lines[0]; // "hello"
```

#### `Server.ifShell`

```ts
ifShell(condition: string, command: string, options?: IfShellOptions): Promise<void>
```

Run one command or another depending on a condition.

```ts
await server.ifShell("test -d /tmp", "display-message 'present'");
```

#### `Server.isAlive`

```ts
isAlive(): Promise<boolean>
```

Whether the tmux server is reachable.

A missing daemon, socket, or tmux executable answers false. Cancellation,
a command deadline, or an engine programming error still raises: none says
whether the server is alive.

```ts
if (await server.isAlive()) {
  await server.snapshot();
}
```

#### `Server.raiseIfDead`

```ts
raiseIfDead(): Promise<void>
```

Assert the server is reachable, raising with tmux's reason if not.

Every read already raises on an unreachable server, so this is not what
tells an empty result from a missing one — it is the assertion form of
{@link isAlive}, for a caller that wants the check and the reason without a
read to hang it on.

```ts
await server.raiseIfDead(); // throws when no tmux server is listening
```

#### `Server.cmd`

```ts
cmd( command: string, args: readonly string[] = [], options?: CmdOptions, ): Promise<readonly string[]>
```

Run a tmux command this package does not model.

tmux has many more commands than any wrapper types. Rather than leaving a
caller to build their own subprocess — and reproduce the socket, the
environment, the deadline, and the error handling — this runs one through
the same path every other operation uses.

Failure raises {@link TmuxCommandError} like any other command, carrying
tmux's own stderr.

```ts
await server.cmd("list-keys", ["-T", "copy-mode"]);
```

#### `Server.pipeline`

```ts
pipeline( commands: readonly (readonly string[])[], options?: CommandOptions, ): Promise<readonly (readonly string[])[]>
```

Run several tmux commands in one invocation.

tmux takes a sequence of commands, which is the difference between building
a ten-window workspace with one process and doing it with ten. The result is
positional — `results[i]` holds what `commands[i]` printed, empty for a
command that prints nothing — so a creating command's `-P -F` lands where
you asked for it.

Not atomic. tmux runs the commands in order and stops at the first failure,
leaving everything before it applied; the error names the command that
failed. Take a {@link Server.snapshot} afterwards if you need to know what
survived.

A connected server sends these one at a time instead, which costs the same
over a connection that is already open.

```ts
const [[first], [second]] = await server.pipeline([
  ["new-window", "-d", "-P", "-F", "#{window_id}"],
  ["new-window", "-d", "-P", "-F", "#{window_id}"],
]);
```

#### `Server.batch`

```ts
async batch<const T extends readonly PlannedOperation<unknown>[]>( operations: T, options?: CommandOptions, ): Promise<
```

Run planned mutations as one invocation, resolving each to what it made.

The batched form of calling them one at a time: the same options go in and
the same handles come out, positionally and individually typed. What
changes is the cost. Calling `newWindow` ten times spends ten invocations
and ten snapshots, because each has to find what it just created; a batch
spends one of each for the whole group.

Not atomic, for the same reason {@link Server.pipeline} is not: tmux runs
them in order and stops at the first failure, leaving everything before it
applied.

```ts
const [editor, logs] = await server.batch([
  session.plan.newWindow({ name: "editor" }),
  session.plan.newWindow({ name: "logs" }),
]);
```

## Session

[`server`](#sessionserver) · [`windows`](#sessionwindows) · [`panes`](#sessionpanes) · [`showOptions`](#sessionshowoptions) · [`showResolvedOptions`](#sessionshowresolvedoptions) · [`setOption`](#sessionsetoption) · [`unsetOption`](#sessionunsetoption) · [`showHooks`](#sessionshowhooks) · [`setHook`](#sessionsethook) · [`unsetHook`](#sessionunsethook) · [`showEnvironment`](#sessionshowenvironment) · [`getEnvironment`](#sessiongetenvironment) · [`setEnvironment`](#sessionsetenvironment) · [`unsetEnvironment`](#sessionunsetenvironment) · [`removeEnvironment`](#sessionremoveenvironment) · [`activeWindow`](#sessionactivewindow) · [`activePane`](#sessionactivepane) · [`newWindow`](#sessionnewwindow) · [`plan`](#sessionplan) · [`kill`](#sessionkill) · [`refreshed`](#sessionrefreshed) · [`rename`](#sessionrename) · [`selectWindow`](#sessionselectwindow) · [`fromEnv`](#sessionfromenv) · [`detach`](#sessiondetach) · [`cmd`](#sessioncmd) · [`sameTmuxIdAs`](#sessionsametmuxidas)

### Properties

#### `Session.server`

```ts
declare readonly server: Server
```

The server this handle addresses.

```ts
session.server.socketPath;
```

#### `Session.windows`

```ts
get windows(): Selection<Window>
```

Windows placed in this session, in listing order.

Resolved from the graph this handle was materialized against, so it issues
no tmux command and reports the instant the handle came from.

```ts
session.windows.count();
session.windows.where({ name: "editor" }).first();
```

#### `Session.panes`

```ts
get panes(): Selection<Pane>
```

Panes contained by this session's windows.

```ts
session.panes.where({ currentCommand: "vim" }).count();
```

#### `Session.activeWindow`

```ts
get activeWindow(): Window | undefined
```

The window tmux marks active in this session.

```ts
session.activeWindow?.name;
```

#### `Session.activePane`

```ts
get activePane(): Pane | undefined
```

The pane tmux marks active in this session's active window.

This is two hops rather than one because `pane_active` is per window: every
window has an active pane, and only the active window's is the session's.

```ts
await session.activePane?.sendKeys("echo hello");
```

#### `Session.plan`

```ts
get plan(): SessionPlans
```

The same mutations, described instead of run.

`session.plan.newWindow(…)` takes what `session.newWindow(…)` takes and
resolves to what it resolves to; it just hands the work to
{@link Server.batch} rather than doing it now. A batch spends one
invocation and one snapshot on the whole group, where calling them one at a
time spends both per call.

```ts
const [editor, logs] = await server.batch([
  session.plan.newWindow({ name: "editor" }),
  session.plan.newWindow({ name: "logs" }),
]);
```

### Methods

#### `Session.showOptions`

```ts
showOptions(): Promise<ReadonlyMap<string, string>>
```

Every option set on this session itself, not the ones it inherits.

A fresh session usually has none, so an empty map here means nothing was
set on this session — not that the option has no value. `showResolvedOptions`
answers what actually governs it.

```ts
const options = await session.showOptions();
options.get("status");
```

#### `Session.showResolvedOptions`

```ts
showResolvedOptions(): Promise<ReadonlyMap<string, string>>
```

The option values that govern this session, own and inherited together.

`showOptions` reports only what was set here, which for a fresh session is
often nothing. This resolves what it inherits as well, so an option has an
answer wherever it was actually set.

```ts
(await session.showResolvedOptions()).get("history-limit");
```

#### `Session.setOption`

```ts
setOption(name: string, value: string, options?: SetOptionOptions): Promise<void>
```

Set an option on this session.

```ts
await session.setOption("status", "off");
```

#### `Session.unsetOption`

```ts
unsetOption(name: string): Promise<void>
```

Remove an option from this session.

```ts
await session.unsetOption("status");
```

#### `Session.showHooks`

```ts
showHooks(): Promise<ReadonlyMap<string, readonly string[]>>
```

Every hook this session reports.

A hook is an array of commands, keyed by the name `setHook` takes, so
what was set reads back under the name it was set with. tmux prints each
element as `name[0]`, which composes with neither of the writers.

```ts
const hooks = await session.showHooks();
hooks.get("window-linked")?.[0];
```

#### `Session.setHook`

```ts
setHook(name: string, command: string, options?: SetHookOptions): Promise<void>
```

Bind a tmux command to a hook on this session.

A hook holds a list of commands. Without `append` this writes the whole
list, so it replaces whatever the hook already ran.

```ts
await session.setHook("window-linked", "display-message 'linked'");
await session.setHook("window-linked", "display-message 'twice'", { append: true });
```

#### `Session.unsetHook`

```ts
unsetHook(name: string): Promise<void>
```

Remove a hook from this session.

```ts
await session.unsetHook("window-linked");
```

#### `Session.showEnvironment`

```ts
showEnvironment(): Promise<ReadonlyMap<string, EnvironmentValue>>
```

Every variable in this session's environment.

A `null` value is tmux's `-NAME`: present, and marked for removal from any
process tmux starts.

```ts
const environment = await session.showEnvironment();
environment.get("EDITOR");
```

#### `Session.getEnvironment`

```ts
getEnvironment(name: string): Promise<EnvironmentValue | undefined>
```

One variable from this session's environment, or `undefined` when tmux carries no entry.

```ts
await session.getEnvironment("EDITOR"); // "vim", null, or undefined
```

#### `Session.setEnvironment`

```ts
setEnvironment(name: string, value: string, options?: SetEnvironmentOptions): Promise<void>
```

Set a variable in this session's environment.

```ts
await session.setEnvironment("EDITOR", "vim");
```

#### `Session.unsetEnvironment`

```ts
unsetEnvironment(name: string): Promise<void>
```

Drop a variable from this session's environment entirely.

```ts
await session.unsetEnvironment("EDITOR");
```

#### `Session.removeEnvironment`

```ts
removeEnvironment(name: string): Promise<void>
```

Mark a variable in this session's environment for removal from the environment of processes
tmux starts, leaving the entry in place.

```ts
await session.removeEnvironment("EDITOR");
```

#### `Session.newWindow`

```ts
newWindow(options?: NewWindowOptions): Promise<Window>
```

Create a window in this session and resolve it as a handle.

```ts
const created = await session.newWindow({ name: "editor" });
created.name; // "editor"
```

#### `Session.kill`

```ts
kill(): Promise<void>
```

Destroy this session.

```ts
await session.kill();
```

#### `Session.refreshed`

```ts
refreshed(): Promise<Session>
```

This session, read again at a new instant.

The receiver keeps the instant it was read at; the answer is a new handle
on a new snapshot, so neither reading contradicts itself.

```ts
const later = await session.refreshed();
later.windows.count();
```

#### `Session.rename`

```ts
rename(name: string): Promise<void>
```

Rename this session.

```ts
await session.rename("renamed");
```

#### `Session.selectWindow`

```ts
selectWindow(target: WindowTarget): Promise<void>
```

Select the last, next, or previous window, or one named by target.

```ts
await session.selectWindow("next");
```

#### `Session.fromEnv`

```ts
static async fromEnv( environment: Readonly<Record<string, string | undefined>> = process.env, ): Promise<Session>
```

Resolve the session this process is running inside.

The pane is authoritative: `$TMUX`'s exported session id goes stale when a
pane is moved, so the session is looked up through `$TMUX_PANE` instead.

```ts
const current = await Session.fromEnv();
current.name;
```

#### `Session.detach`

```ts
detach(): Promise<void>
```

Detach every client attached to this session.

```ts
await session.detach();
```

#### `Session.cmd`

```ts
cmd( command: string, args: readonly string[] = [], options?: CmdOptions, ): Promise<readonly string[]>
```

Run a tmux command this package does not model, addressed at this session.

The first argument is the tmux command name and nothing else — this does
not parse a command line, so arguments go in the array:

The session's id is sent as the target; pass `target` to address something
else, or `null` for a command that takes none.

```ts
await session.cmd("rename-session", ["--", "renamed"]);
```

#### `Session.sameTmuxIdAs`

```ts
sameTmuxIdAs(other: Session): boolean
```

Whether `other` carries the same `$n`, wherever it came from.

Sessions on unrelated servers routinely share an id; this says so, and
{@link equals} says they are still different sessions.

```ts
session.sameTmuxIdAs(await session.refreshed()); // true
```

## Window

[`server`](#windowserver) · [`panes`](#windowpanes) · [`session`](#windowsession) · [`activePane`](#windowactivepane) · [`linkedSessions`](#windowlinkedsessions) · [`showHooks`](#windowshowhooks) · [`setHook`](#windowsethook) · [`unsetHook`](#windowunsethook) · [`showOptions`](#windowshowoptions) · [`showResolvedOptions`](#windowshowresolvedoptions) · [`setOption`](#windowsetoption) · [`unsetOption`](#windowunsetoption) · [`split`](#windowsplit) · [`plan`](#windowplan) · [`nextLayout`](#windownextlayout) · [`previousLayout`](#windowpreviouslayout) · [`rotate`](#windowrotate) · [`resize`](#windowresize) · [`respawn`](#windowrespawn) · [`kill`](#windowkill) · [`rename`](#windowrename) · [`move`](#windowmove) · [`link`](#windowlink) · [`unlink`](#windowunlink) · [`removePlacement`](#windowremoveplacement) · [`swapWith`](#windowswapwith) · [`selectLayout`](#windowselectlayout) · [`select`](#windowselect) · [`refreshed`](#windowrefreshed) · [`cmd`](#windowcmd) · [`sameTmuxIdAs`](#windowsametmuxidas)

### Properties

#### `Window.server`

```ts
declare readonly server: Server
```

The server this handle addresses.

```ts
window.server.socketPath;
```

#### `Window.panes`

```ts
get panes(): Selection<Pane>
```

Panes of this window placement; a linked window keeps each set apart.

```ts
window.panes.count();
window.panes.at(0)?.id;
```

#### `Window.session`

```ts
get session(): Session | undefined
```

The session this placement belongs to.

```ts
window.session?.name;
```

#### `Window.activePane`

```ts
get activePane(): Pane | undefined
```

The pane tmux marks active in this window.

`pane_active` is scoped to a window, so filtering a session's panes on it
yields one per window rather than one overall. Reaching the active pane
through the window it belongs to is what makes the answer singular.

```ts
await window.activePane?.sendKeys("echo hello");
```

#### `Window.linkedSessions`

```ts
get linkedSessions(): Selection<Session>
```

Every session this window is linked into.

```ts
window.linkedSessions.map((entry) => entry.name);
```

#### `Window.plan`

```ts
get plan(): WindowPlans
```

The same mutations, described instead of run.

Takes what the direct calls take and resolves to what they resolve to,
for {@link Server.batch} to spend one invocation and one snapshot on.

```ts
const [created] = await server.batch([window.plan.split({})]);
created.id;
```

### Methods

#### `Window.showHooks`

```ts
showHooks(): Promise<ReadonlyMap<string, readonly string[]>>
```

#### `Window.setHook`

```ts
setHook(name: string, command: string, options?: SetHookOptions): Promise<void>
```

#### `Window.unsetHook`

```ts
unsetHook(name: string): Promise<void>
```

#### `Window.showOptions`

```ts
showOptions(): Promise<ReadonlyMap<string, string>>
```

Every option set on this window itself, not the ones it inherits.

A fresh window usually has none, so an empty map here means nothing was
set on this window — not that the option has no value. `showResolvedOptions`
answers what actually governs it.

```ts
const options = await window.showOptions();
options.get("automatic-rename");
```

#### `Window.showResolvedOptions`

```ts
showResolvedOptions(): Promise<ReadonlyMap<string, string>>
```

The option values that govern this window, own and inherited together.

`showOptions` reports only what was set here, which for a fresh window is
often nothing. This resolves what it inherits as well, so an option has an
answer wherever it was actually set.

```ts
(await window.showResolvedOptions()).get("main-pane-width");
```

#### `Window.setOption`

```ts
setOption(name: string, value: string, options?: SetOptionOptions): Promise<void>
```

Set an option on this window.

```ts
await window.setOption("automatic-rename", "off");
```

#### `Window.unsetOption`

```ts
unsetOption(name: string): Promise<void>
```

Remove an option from this window.

```ts
await window.unsetOption("automatic-rename");
```

#### `Window.split`

```ts
split(options?: SplitOptions): Promise<Pane>
```

Split this window and resolve the created pane.

```ts
const created = await window.split({ vertical: true });
created.id;
```

#### `Window.nextLayout`

```ts
nextLayout(): Promise<void>
```

Apply this window's next layout preset.

tmux cycles a fixed list — even-horizontal, even-vertical, main-horizontal,
main-vertical, tiled — rearranging the panes already there.

```ts
await window.nextLayout();
```

#### `Window.previousLayout`

```ts
previousLayout(): Promise<void>
```

Apply this window's previous layout preset.

```ts
await window.previousLayout();
```

#### `Window.rotate`

```ts
rotate(direction: "forward" | "backward" = "forward"): Promise<void>
```

Rotate the panes within this window.

The layout stays put and the panes move through it, so this reorders what
occupies each position rather than trading two panes.

```ts
await window.rotate("forward");
```

#### `Window.resize`

```ts
resize(options: ResizeWindowOptions): Promise<void>
```

Resize this window, by a direction, to a size, or to what its clients allow.

Under tmux's default `window-size` a window tracks its attached clients,
which will overwrite this the next time they change; `window-size manual`
is what makes a size of your own stick.

```ts
await window.resize({ height: 30, width: 100 });
```

#### `Window.respawn`

```ts
respawn(command?: string, options?: RespawnOptions): Promise<void>
```

Restart the command running in this window's active pane.

tmux refuses a window that is still running something unless `kill` says
to replace it.

```ts
await window.respawn("sh", { kill: true });
```

#### `Window.kill`

```ts
kill(): Promise<void>
```

Destroy this window, unlinking it from every session it is in.

```ts
await window.kill();
```

#### `Window.rename`

```ts
rename(name: string): Promise<void>
```

Rename this window.

```ts
await window.rename("editor");
```

#### `Window.move`

```ts
move(options: MoveWindowOptions = {}): Promise<void>
```

Move this window to another session or index without selecting it.

Moves this placement. Sessions that are grouped share one window list, so
moving a window they share moves it in all of them; sessions that merely
link the same window keep their own lists, and only this one moves.

```ts
await window.move({ index: 3 });
```

#### `Window.link`

```ts
link(options: MoveWindowOptions): Promise<void>
```

Link this window into another session, giving it a second placement.

```ts
await window.link({ session: "other" });
```

#### `Window.unlink`

```ts
unlink(): Promise<void>
```

Remove this placement, leaving the window's other placements intact.

For a window linked into several sessions. A window shared because its
sessions are grouped is not linked, and tmux refuses with "window only
linked to one session" — a group member leaves by being killed, not by
unlinking.

```ts
await window.unlink();
```

#### `Window.removePlacement`

```ts
removePlacement(): Promise<void>
```

Remove this placement, destroying an unshared window but refusing a group.

```ts
await window.removePlacement();
```

#### `Window.swapWith`

```ts
swapWith(other: Window): Promise<void>
```

Exchange positions with another window.

```ts
await window.swapWith(other);
```

#### `Window.selectLayout`

```ts
selectLayout(layout: string): Promise<void>
```

Apply a named or custom layout.

```ts
await window.selectLayout("even-horizontal");
```

#### `Window.select`

```ts
select(): Promise<void>
```

Make this window active in its session.

```ts
await window.select();
```

#### `Window.refreshed`

```ts
refreshed(): Promise<Window>
```

This window placement, read again at a new instant.

The placement is kept, not just the window: a window linked into a session
at two indexes has two placements, and this one stays the one it was.
Refusing rather than silently retargeting is why the index is part of what
is matched.

```ts
const later = await window.refreshed();
later.panes.count();
```

#### `Window.cmd`

```ts
cmd( command: string, args: readonly string[] = [], options?: CmdOptions, ): Promise<readonly string[]>
```

Run a tmux command this package does not model, addressed at this window.

The window's id is sent as the target; pass `target` to address something
else, or `null` for a command that takes none — `display-panes` takes a
client, so it wants `{ target: null }` and not this window's `@n`.

```ts
await window.cmd("rotate-window");
```

#### `Window.sameTmuxIdAs`

```ts
sameTmuxIdAs(other: Window): boolean
```

Whether `other` carries the same `@n`, wherever it came from.

```ts
window.sameTmuxIdAs(other);
```

## Pane

[`server`](#paneserver) · [`window`](#panewindow) · [`session`](#panesession) · [`showHooks`](#paneshowhooks) · [`setHook`](#panesethook) · [`unsetHook`](#paneunsethook) · [`showOptions`](#paneshowoptions) · [`showResolvedOptions`](#paneshowresolvedoptions) · [`setOption`](#panesetoption) · [`unsetOption`](#paneunsetoption) · [`split`](#panesplit) · [`kill`](#panekill) · [`killIfWindowUnshared`](#panekillifwindowunshared) · [`plan`](#paneplan) · [`sendKeys`](#panesendkeys) · [`capture`](#panecapture) · [`clearHistory`](#paneclearhistory) · [`resize`](#paneresize) · [`swapWith`](#paneswapwith) · [`select`](#paneselect) · [`setTitle`](#panesettitle) · [`pasteBuffer`](#panepastebuffer) · [`refreshed`](#panerefreshed) · [`displayMessage`](#panedisplaymessage) · [`respawn`](#panerespawn) · [`pipeTo`](#panepipeto) · [`breakOut`](#panebreakout) · [`joinTo`](#panejointo) · [`enterCopyMode`](#paneentercopymode) · [`exitCopyMode`](#paneexitcopymode) · [`displayPopup`](#panedisplaypopup) · [`displayMenu`](#panedisplaymenu) · [`chooseTree`](#panechoosetree) · [`chooseBuffer`](#panechoosebuffer) · [`findWindow`](#panefindwindow) · [`sendPrefix`](#panesendprefix) · [`customizeMode`](#panecustomizemode) · [`cmd`](#panecmd) · [`sameTmuxIdAs`](#panesametmuxidas)

### Properties

#### `Pane.server`

```ts
declare readonly server: Server
```

The server this pane belongs to.

```ts
pane.server.socketPath;
```

#### `Pane.window`

```ts
get window(): Window | undefined
```

The window placement containing this pane.

```ts
pane.window?.name;
```

#### `Pane.session`

```ts
get session(): Session | undefined
```

The session containing this pane.

```ts
pane.session?.name;
```

#### `Pane.plan`

```ts
get plan(): PanePlans
```

The same mutations, described instead of run.

Takes what the direct calls take and resolves to what they resolve to,
for {@link Server.batch} to spend one invocation and one snapshot on.

```ts
const [created] = await server.batch([pane.plan.split({})]);
created.id;
```

### Methods

#### `Pane.showHooks`

```ts
showHooks(): Promise<ReadonlyMap<string, readonly string[]>>
```

#### `Pane.setHook`

```ts
setHook(name: string, command: string, options?: SetHookOptions): Promise<void>
```

#### `Pane.unsetHook`

```ts
unsetHook(name: string): Promise<void>
```

#### `Pane.showOptions`

```ts
showOptions(): Promise<ReadonlyMap<string, string>>
```

Every option set on this pane itself, not the ones it inherits.

A fresh pane usually has none, so an empty map here means nothing was
set on this pane — not that the option has no value. `showResolvedOptions`
answers what actually governs it.

```ts
const options = await pane.showOptions();
options.get("remain-on-exit");
```

#### `Pane.showResolvedOptions`

```ts
showResolvedOptions(): Promise<ReadonlyMap<string, string>>
```

The option values that govern this pane, own and inherited together.

`showOptions` reports only what was set here, which for a fresh pane is
often nothing. This resolves what it inherits as well, so an option has an
answer wherever it was actually set.

```ts
(await pane.showResolvedOptions()).get("allow-rename");
```

#### `Pane.setOption`

```ts
setOption(name: string, value: string, options?: SetOptionOptions): Promise<void>
```

Set an option on this pane.

```ts
await pane.setOption("remain-on-exit", "on");
```

#### `Pane.unsetOption`

```ts
unsetOption(name: string): Promise<void>
```

Remove an option from this pane.

```ts
await pane.unsetOption("remain-on-exit");
```

#### `Pane.split`

```ts
split(options?: SplitOptions): Promise<Pane>
```

Split this pane and resolve the created pane.

```ts
const created = await pane.split({ vertical: true });
created.id;
```

#### `Pane.kill`

```ts
kill(): Promise<void>
```

Destroy this pane.

```ts
await pane.kill();
```

#### `Pane.killIfWindowUnshared`

```ts
killIfWindowUnshared(): Promise<void>
```

Destroy this pane only if its window has one placement.

```ts
await pane.killIfWindowUnshared();
```

#### `Pane.sendKeys`

```ts
sendKeys(keys: string, options?: SendKeysOptions): Promise<void>
```

Send keys to this pane, following them with Enter unless told not to.

```ts
await pane.sendKeys("echo hello");
await pane.sendKeys("C-c", { literal: false });
```

#### `Pane.capture`

```ts
capture(options?: CaptureOptions): Promise<readonly string[]>
```

Capture this pane's contents as lines.

```ts
const lines = await pane.capture();
lines.at(-1);
```

#### `Pane.clearHistory`

```ts
clearHistory(): Promise<void>
```

Discard this pane's scrollback history.

```ts
await pane.clearHistory();
```

#### `Pane.resize`

```ts
resize(options: ResizeOptions): Promise<void>
```

Resize this pane; tmux ignores a dimension its layout cannot honour.

```ts
await pane.resize({ height: 20 });
```

#### `Pane.swapWith`

```ts
swapWith(other: Pane): Promise<void>
```

Exchange positions with another pane.

```ts
await pane.swapWith(otherPane);
```

#### `Pane.select`

```ts
select(): Promise<void>
```

Make this pane active in its window.

```ts
await pane.select();
```

#### `Pane.setTitle`

```ts
setTitle(title: string): Promise<void>
```

Set this pane's title.

The title is what `#{pane_title}` reports and what a `pane-border-format`
draws; a program running in the pane can also set it through the terminal,
so it is not solely the caller's to own.

```ts
await pane.setTitle("build");
```

#### `Pane.pasteBuffer`

```ts
pasteBuffer(name: string): Promise<void>
```

Paste a named buffer into this pane, as if it were typed.

The program running in the pane sees ordinary input, so a shell runs what
arrives. {@link Server.loadBuffer} fills the buffer beforehand.

```ts
await pane.pasteBuffer("greeting");
```

#### `Pane.refreshed`

```ts
refreshed(): Promise<Pane>
```

This pane, read again at a new instant.

```ts
const later = await pane.refreshed();
later.currentCommand;
```

#### `Pane.displayMessage`

```ts
displayMessage(message: string): Promise<readonly string[]>
```

Expand a tmux format string against this pane.

```ts
const shown = await pane.displayMessage("#{pane_index}");
shown[0];
```

#### `Pane.respawn`

```ts
respawn(command?: string, options?: RespawnOptions): Promise<void>
```

Restart this pane's command in place.

```ts
await pane.respawn("htop", { kill: true });
```

#### `Pane.pipeTo`

```ts
pipeTo(command?: string, options?: { readonly toggle?: boolean }): Promise<void>
```

Send everything this pane writes to a shell command as well as its screen.

A pane keeps `history-limit` lines and a stream reader keeps a bounded
buffer, so output larger than either is gone before anything asks for it.
The command runs for as long as the pipe is open, which is how a long
build is captured whole. Pass no command to stop one.

```ts
await pane.pipeTo("cat >> /tmp/build.log");
```

#### `Pane.breakOut`

```ts
breakOut(windowName?: string): Promise<void>
```

Move this pane out into a window of its own, in the session it is in.

tmux places a break with no destination in whichever session is current,
which is the attached one rather than this pane's.

```ts
await pane.breakOut("extracted");
```

#### `Pane.joinTo`

```ts
joinTo(target: string, options?: JoinOptions): Promise<void>
```

Move this pane into another window as a split.

```ts
await pane.joinTo(window.id, { vertical: true });
```

#### `Pane.enterCopyMode`

```ts
enterCopyMode(): Promise<void>
```

Enter this pane's copy mode.

```ts
await pane.enterCopyMode();
```

#### `Pane.exitCopyMode`

```ts
exitCopyMode(): Promise<void>
```

Leave this pane's copy mode.

```ts
await pane.exitCopyMode();
```

#### `Pane.displayPopup`

```ts
displayPopup(command?: string, options?: PopupOptions): Promise<void>
```

Open a popup over the client showing this pane.

```ts
await pane.displayPopup("htop", { width: "80%" });
```

#### `Pane.displayMenu`

```ts
displayMenu(title: string, items: readonly MenuItem[]): Promise<void>
```

Show a menu over the client showing this pane.

```ts
await pane.displayMenu("Actions", [{ command: "kill-pane", key: "k", name: "Kill" }]);
```

#### `Pane.chooseTree`

```ts
chooseTree(options?: ChooseTreeOptions): Promise<void>
```

Open the interactive session and window chooser in this pane.

tmux needs a client attached to the session to draw this. With none, it
does nothing and reports success, so a headless run is told it worked.

```ts
await pane.chooseTree({ sessionsOnly: true });
```

#### `Pane.chooseBuffer`

```ts
chooseBuffer(): Promise<void>
```

Open the interactive buffer chooser in this pane.

tmux needs a client attached to the session to draw this. With none, it
does nothing and reports success, so a headless run is told it worked.

```ts
await pane.chooseBuffer();
```

#### `Pane.findWindow`

```ts
findWindow(pattern: string): Promise<void>
```

Search windows interactively from this pane.

tmux needs a client attached to the session to draw this. With none, it
does nothing and reports success, so a headless run is told it worked.

```ts
await pane.findWindow("editor");
```

#### `Pane.sendPrefix`

```ts
sendPrefix(): Promise<void>
```

Send the configured prefix key to this pane.

tmux needs a client attached to the session to draw this. With none, it
does nothing and reports success, so a headless run is told it worked.

```ts
await pane.sendPrefix();
```

#### `Pane.customizeMode`

```ts
customizeMode(): Promise<void>
```

Open tmux's interactive option editor in this pane.

tmux needs a client attached to the session to draw this. With none, it
does nothing and reports success, so a headless run is told it worked.

```ts
await pane.customizeMode();
```

#### `Pane.cmd`

```ts
cmd( command: string, args: readonly string[] = [], options?: CmdOptions, ): Promise<readonly string[]>
```

Run a tmux command this package does not model, addressed at this pane.

The pane's id is sent as the target; pass `target` to address something
else, or `null` for a command that takes none.

```ts
await pane.cmd("clock-mode");
```

#### `Pane.sameTmuxIdAs`

```ts
sameTmuxIdAs(other: Pane): boolean
```

Whether `other` carries the same `%n`, wherever it came from.

```ts
pane.sameTmuxIdAs(await pane.refreshed()); // true
```

## Client

[`server`](#clientserver) · [`session`](#clientsession) · [`window`](#clientwindow) · [`pane`](#clientpane) · [`refreshed`](#clientrefreshed) · [`detach`](#clientdetach) · [`switchTo`](#clientswitchto)

### Properties

#### `Client.server`

```ts
declare readonly server: Server
```

The server this handle addresses.

```ts
client.server.socketPath;
```

#### `Client.session`

```ts
get session(): Session | undefined
```

The session this client is attached to, if it is still attached.

```ts
client.session?.name;
```

#### `Client.window`

```ts
get window(): Window | undefined
```

The window placement this client currently shows.

```ts
client.window?.name;
```

#### `Client.pane`

```ts
get pane(): Pane | undefined
```

The pane this client currently has active.

```ts
client.pane?.id;
```

### Methods

#### `Client.refreshed`

```ts
refreshed(): Promise<Client>
```

This client, read again at a new instant.

```ts
const later = await client.refreshed();
later.session?.name;
```

#### `Client.detach`

```ts
detach(): Promise<void>
```

Detach this client from its server.

```ts
await client.detach();
```

#### `Client.switchTo`

```ts
switchTo(session: Session): Promise<void>
```

Point this client at a different session.

```ts
await client.switchTo(session);
```

## Selection

An immutable, ordered set of tmux objects read at one instant.

A Selection is deliberately not an Array. It is `Iterable` and it never
changes, so the answer it gave a moment ago is still the answer now — which
is what lets a snapshot be reasoned about at all. `toArray()` is the one
crossing to array semantics, and everything Array offers that this does not
lives on the other side of it.

Two ways to narrow, never overloaded into each other: `where` takes
declarative criteria that are data — serializable, inspectable, sendable over
a wire — and `filter` takes an ordinary predicate. Reach for `where` unless
the question genuinely needs to run code.

[`length`](#selectionlength) · [`[Symbol.iterator]`](#selectionsymboliterator) · [`at`](#selectionat) · [`toArray`](#selectiontoarray) · [`map`](#selectionmap) · [`filter`](#selectionfilter) · [`where`](#selectionwhere) · [`first`](#selectionfirst) · [`one`](#selectionone) · [`oneOrUndefined`](#selectiononeorundefined) · [`exists`](#selectionexists) · [`count`](#selectioncount)

### Properties

#### `Selection.length`

```ts
readonly length: number
```

How many members this holds. Unlike `count`, it takes no criteria.

```ts
snapshot.windows.length;
```

### Methods

#### `Selection.[Symbol.iterator]`

```ts
[Symbol.iterator](): IterableIterator<Model>
```

Iterate in tmux's own order.

Each call returns a fresh iterator, so a selection can be walked more than
once: spread it and then loop it, and the second pass is not empty. This is
what `for...of`, spread and destructuring all go through.

```ts
for (const window of snapshot.windows) window.name;
[...snapshot.windows].length === snapshot.windows.length;
```

#### `Selection.at`

```ts
at(index: number): Model | undefined
```

The member at `index`, or undefined when the index is out of range.

```ts
snapshot.windows.at(0)?.name;
snapshot.windows.at(-1)?.name; // counts from the end
```

#### `Selection.toArray`

```ts
toArray(): Model[]
```

A plain array of the members, in order.

The crossing to array semantics: slicing, reversing, indexing, spreading.
The result is a copy, so mutating it cannot disturb the Selection.

```ts
const ordered = snapshot.panes.toArray();
ordered.slice(0, 2).map((entry) => entry.id);
```

#### `Selection.map`

```ts
map<Result>( transform: (value: Model, index: number, values: readonly Model[]) => Result, thisArg?: unknown, ): Result[]
```

Apply `transform` to each member, in order.

Returns an array rather than a Selection: the results are no longer tmux
objects, so they carry no identity to filter, count, or traverse from.

```ts
snapshot.windows.map((entry) => entry.name); // string[]
```

#### `Selection.filter`

```ts
filter<Narrowed extends Model>( predicate: (value: Model, index: number, values: readonly Model[]) => value is Narrowed, thisArg?: unknown, ): Selection<Narrowed>
```

Keep the members `predicate` accepts.

For a question that has to run code. When the question can be expressed as
criteria, `where` says the same thing as data — which can be logged, sent
to another process, or stored.

```ts
snapshot.panes.filter((entry) => entry.currentCommand?.startsWith("v") === true);
```

```ts
filter( predicate: (value: Model, index: number, values: readonly Model[]) => unknown, thisArg?: unknown, ): Selection<Model>
```

Keep the members an ordinary predicate accepts without changing their type.

```ts
snapshot.panes.filter((entry) => entry.active === true);
```

#### `Selection.where`

```ts
where(criteria: WhereOf<Model>): Selection<Model>
```

Keep the members matching declarative criteria.

Criteria are data: equality, string operators, `AND`/`OR`/`NOT`, regular
expressions expressed as `{ pattern, flags }`, and quantifiers over
relations. Matching is case-sensitive unless a criterion says otherwise.

@throws VersionTooLow when a criterion names a field newer than the tmux
that answered. Such a field is not absent from the data, it is absent from
that release, and matching it against nothing would answer "no member has
this" — which is a different statement and the one a caller would act on.
The error names the field, the release that has it, and the release
running.

```ts
snapshot.panes.where({ currentCommand: "vim" });
snapshot.windows.where({ name: { startsWith: "log" } });
```

#### `Selection.first`

```ts
first(criteria?: WhereOf<Model>): Model | undefined
```

The first member, or the first matching `criteria`.

Answers undefined for no match. Use this when zero is an ordinary outcome;
use `one` when it is not.

```ts
snapshot.windows.first({ name: "editor" })?.id;
```

#### `Selection.one`

```ts
one(criteria?: WhereOf<Model>): Model
```

The single member, or the single one matching `criteria`.

Throws `NoMatchError` for none and `MultipleMatchesError` for several, so
"exactly one" is enforced rather than assumed — a `first` that silently
takes the head of two is how the wrong pane gets driven.

An id is not always one member. A window linked into two sessions, or
shared by two grouped sessions, has a placement in each and both carry the
same id, so `one({ id })` raises for a perfectly good id. Add the session
to say which placement is meant.

```ts
const only = snapshot.sessions.one({ name: "work" });
only.id;
```

#### `Selection.oneOrUndefined`

```ts
oneOrUndefined(criteria?: WhereOf<Model>): Model | undefined
```

The single member, or undefined when there is none.

`one` without the empty case: several still throws, because that says the
criteria were wrong rather than that the answer is absent.

```ts
snapshot.sessions.oneOrUndefined({ name: "work" })?.id;
```

#### `Selection.exists`

```ts
exists(criteria?: WhereOf<Model>): boolean
```

Whether anything matches. Cheaper to read than comparing a count to zero.

```ts
if (snapshot.windows.exists({ name: "build" })) {
  await session.selectWindow("build");
}
```

#### `Selection.count`

```ts
count(criteria?: WhereOf<Model>): number
```

How many members match `criteria`, or how many there are without it.

```ts
snapshot.panes.count(); // every pane
snapshot.panes.count({ currentCommand: "vim" });
```
