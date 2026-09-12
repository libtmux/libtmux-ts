/* eslint-disable no-await-in-loop -- Import roots are validated before any builder runs. */
import {
  TmuxCommandError,
  type DaemonIdentity,
  type Server,
  type ServerSnapshot,
  type Session,
} from "libtmux";
import { constants } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CLIContext } from "./app.ts";
import { privatePath, type Document } from "./documents.ts";
import { expand, normalize, workspaceName } from "./normalize.ts";
import { CliError, type OperationOutput, write } from "./output.ts";
import { processRun } from "./process.ts";
import type { LoadResult } from "./tmux.ts";

export type ExtensionSpec = { data: Document; name: string };
export type BorrowedSession = { session: Session; daemon: DaemonIdentity };

export async function extensionPlan(
  data: Document,
  path: string,
  context: CLIContext,
  append: boolean,
  override?: string,
): Promise<ExtensionSpec | undefined> {
  const plugins = data.plugins ?? [];
  if (
    !Array.isArray(plugins) ||
    plugins.some((item) => typeof item !== "string" || !/^\w+(?:\.\w+)+$/.test(item))
  )
    throw new CliError("extension_config", "plugins must be an array of Python dotted class names");
  const builder = data.workspace_builder ?? "";
  if (typeof builder !== "string" || builder.includes("\0"))
    throw new CliError("extension_config", "workspace_builder must be a string");
  const rawPaths = data.workspace_builder_paths ?? [];
  const paths = typeof rawPaths === "string" ? [rawPaths] : rawPaths;
  if (
    !Array.isArray(paths) ||
    paths.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  )
    throw new CliError("extension_config", "workspace_builder_paths must contain directory paths");
  for (const entry of paths) {
    const directory = resolve(dirname(path), expand(entry as string, context));
    if (!(await stat(directory).catch(() => undefined))?.isDirectory())
      throw new CliError(
        "extension_config",
        `Builder import directory does not exist: ${privatePath(directory, context)}`,
      );
  }
  if (!plugins.length && !builder.trim()) return undefined;
  if (append && Object.hasOwn(data, "before_script"))
    throw new CliError(
      "extension_config",
      "Python extension append cannot use before_script; run the script separately",
    );
  const name = workspaceName(data, context, override);
  if (!builder.trim()) normalize(data, path, context, override);
  const config = structuredClone(data);
  if (!builder.trim()) delete config.workspace_builder;
  return { data: config, name };
}

const runtimeCheck = `
from importlib.metadata import version
import inspect
if version("tmuxp") != "1.74.0":
    raise RuntimeError("tmuxp 1.74.0 is required")
from libtmux import Server
from tmuxp.workspace.builder import prepended_sys_path, resolve_builder_class, resolve_builder_paths
if "tmux_bin" not in inspect.signature(Server).parameters:
    raise RuntimeError("libtmux Server must accept tmux_bin")
`;

export async function extensionRuntime(context: CLIContext): Promise<string> {
  const python = context.env.TMUX_WORKSPACE_PYTHON || "python3";
  const timeout = AbortSignal.timeout(10_000);
  try {
    const result = await processRun([python, "-c", runtimeCheck], {
      cwd: context.cwd,
      env: context.env,
      signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim());
  } catch (error) {
    context.signal?.throwIfAborted();
    throw new CliError(
      "python_runtime",
      `Python extensions require tmuxp 1.74.0 and its builder registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return python;
}

const adapter = String.raw`
import importlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

request = json.load(sys.stdin)
executable = shutil.which(request["server"]["tmux_bin"])
if executable is None:
    raise RuntimeError("selected tmux executable was not found")
binary = Path(request["state_path"]).parent / "tmux"
request["server"]["tmux_bin"] = str(Path(executable).resolve())
binary.symlink_to(request["server"]["tmux_bin"])
for key in ("socket_path", "config_file"):
    if request["server"].get(key):
        request["server"][key] = str(Path(request["server"][key]).absolute())
os.environ["PATH"] = str(binary.parent) + os.pathsep + os.environ.get("PATH", "")

from libtmux import Server
from tmuxp.workspace import loader
from tmuxp.workspace.builder import prepended_sys_path, resolve_builder_class, resolve_builder_paths

config = request["config"]
custom = bool((config.get("workspace_builder") or "").strip())
config["session_name"] = request["session_name"]
config = loader.expand(config, cwd=str(Path(request["source"]).parent))
if not custom or "windows" in config:
    config = loader.trickle(config)
config["session_name"] = request["session_name"]
server = Server(**request["server"])
borrowed = request.get("borrowed")
builder = None

def authenticate():
    if borrowed is None:
        return None
    identity = borrowed["daemon"]
    expected = f"{identity['pid']}:{identity['startTime']}"
    if server.cmd("display-message", "-p", "#{pid}:#{start_time}").stdout != [expected]:
        raise RuntimeError("authenticated append daemon changed")
    session = server.sessions.get(session_id=borrowed["session_id"], default=None)
    if session is None:
        raise RuntimeError("authenticated append session disappeared")
    return session

try:
    authenticate()
    with prepended_sys_path(resolve_builder_paths(config, request["source"])):
        plugins = []
        for target in config.get("plugins") or []:
            module, _, name = target.rpartition(".")
            plugins.append(getattr(importlib.import_module(module), name)())
        builder = resolve_builder_class(config)(session_config=config, server=server, plugins=plugins)
        session = authenticate()
        builder.build(session=session, append=session is not None)
        for plugin in builder.plugins:
            plugin.before_script(builder.session)
finally:
    session_id = borrowed["session_id"] if borrowed is not None else None
    if builder is not None:
        try:
            session_id = builder.session.id
        except Exception:
            pass
    if not isinstance(session_id, str) or not re.fullmatch(r"\$\d+", session_id):
        session_id = None
    Path(request["state_path"]).write_text(json.dumps({"session_id": session_id}), encoding="utf-8")
`;

async function sessionHint(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Extension state is not a regular file");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > 4096) throw new Error("Extension state exceeds 4 KiB");
    const state: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const id =
      state && typeof state === "object" && "session_id" in state ? state.session_id : undefined;
    if (id === null) return undefined;
    if (typeof id !== "string" || !/^\$\d+$/.test(id))
      throw new Error("Invalid extension session ID");
    return id;
  } finally {
    await file.close();
  }
}

function sameDaemon(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

async function baseline(server: Server, signal?: AbortSignal): Promise<ServerSnapshot | undefined> {
  try {
    await server.cmd("list-sessions", [], signal ? { signal } : {});
  } catch (error) {
    if (
      error instanceof TmuxCommandError &&
      error.exitCode === 1 &&
      !error.stdout.length &&
      error.stderr.length === 1 &&
      /^(?:no server running on .+|error connecting to .+ \((?:No such file or directory|Connection refused)\))$/.test(
        error.stderr[0]!,
      )
    )
      return undefined;
    throw error;
  }
  return server.snapshot(signal ? { signal } : {});
}

export async function buildExtension(
  python: string,
  spec: ExtensionSpec,
  source: string,
  server: Server,
  context: CLIContext,
  output: OperationOutput,
  result: LoadResult,
  borrowed?: BorrowedSession,
): Promise<Session> {
  const before = await baseline(server, context.signal);
  if (
    borrowed &&
    (!before ||
      !sameDaemon(borrowed.daemon, before.daemonIdentity) ||
      !before.sessions.toArray().some((session) => session.id === borrowed.session.id))
  )
    throw new CliError("tmux_context", "The authenticated append session or daemon changed");
  const existing =
    !borrowed && before?.sessions.toArray().find((session) => session.name === spec.name);
  if (existing) {
    result.reused = true;
    return existing;
  }
  const directory = await mkdtemp(join(tmpdir(), "tmux-workspace-extension-"));
  const statePath = join(directory, "state.json");
  result.stage = "extension-build";
  result.effects_scope = "observed";
  result.observed_windows = [];
  result.observed_panes = [];
  let session: Session | undefined;
  let failed: unknown;
  try {
    await output.event("extension-started", { input_index: result.input_index });
    result.effects_unknown = true;
    try {
      result.script_output = await processRun([python, "-u", "-c", adapter], {
        cwd: context.cwd,
        env: { ...context.env, TMUX: undefined, TMUX_PANE: undefined },
        ...(context.signal ? { signal: context.signal } : {}),
        input: JSON.stringify({
          config: spec.data,
          source,
          session_name: spec.name,
          state_path: statePath,
          server: {
            tmux_bin: server.tmuxBin,
            socket_path: server.socketPath,
            socket_name: server.socketName,
            config_file: server.configFile,
            colors: server.colors,
          },
          ...(borrowed
            ? { borrowed: { session_id: borrowed.session.id, daemon: borrowed.daemon } }
            : {}),
        }),
        output: async (stream, text) => {
          const handled = await output.event("script-output", {
            input_index: result.input_index,
            stream,
            text,
          });
          if (output.mode === "human" && !handled)
            await write(context[stream], text, context.signal);
        },
      });
      if (result.script_output.code !== 0)
        throw new CliError(
          "extension_failed",
          `Python extension exited with status ${result.script_output.code}`,
        );
    } catch (error) {
      failed = error;
    }
    try {
      const after = await server.snapshot({ signal: AbortSignal.timeout(1000) });
      if (before && !sameDaemon(before.daemonIdentity, after.daemonIdentity))
        throw new Error("Daemon changed during extension execution");
      const oldWindows = new Set(before?.windows.toArray().map((window) => window.id));
      const oldPanes = new Set(before?.panes.toArray().map((pane) => pane.id));
      result.observed_windows = after.windows
        .toArray()
        .map((window) => window.id)
        .filter((id) => !oldWindows.has(id));
      result.observed_panes = after.panes
        .toArray()
        .map((pane) => pane.id)
        .filter((id) => !oldPanes.has(id));
      const hint = borrowed?.session.id ?? (await sessionHint(statePath));
      session = after.sessions.toArray().find((item) => item.id === hint);
      if (!session) throw new Error("Extension did not identify a surviving session");
      result.session_id = session.id;
      result.session_name = session.name ?? spec.name;
    } catch (error) {
      result.observation_error = error instanceof Error ? error.message : String(error);
      failed ??= new CliError("extension_observation", result.observation_error);
    }
    if (failed !== undefined) throw failed;
    result.completed_stages.push("extension-built");
    await output.event("extension-completed", { input_index: result.input_index });
    return session!;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
