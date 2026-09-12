/* eslint-disable no-await-in-loop -- Each mutation and progress record depends on the preceding tmux state. */
import { Server, type Pane, type Session, type Window } from "libtmux";
import { setTimeout as sleep } from "node:timers/promises";
import { extname, resolve } from "node:path";
import type { CLIContext } from "./app.ts";
import {
  scalarText,
  expandPath,
  mapping,
  privatePath,
  readDocument,
  resolveWorkspace,
  saveDocument,
  type Document,
  type Json,
} from "./documents.ts";
import { normalize, type PaneSpec, type WorkspaceSpec } from "./normalize.ts";
import { CliError, colorEnabled, emitJson, OperationOutput, styled, write } from "./output.ts";
import type { Request } from "./parser.ts";
import { openTerminal, processRun } from "./process.ts";
import type { ProcessResult } from "./process.ts";
import type { BorrowedSession, ExtensionSpec } from "./extensions.ts";

export type LoadResult = {
  input_index: number;
  workspace: string;
  session_name: string;
  session_id?: string;
  reused: boolean;
  appended: boolean;
  stage: string;
  completed_stages: string[];
  created_windows: string[];
  created_panes: string[];
  session_removed?: boolean;
  script_output?: ProcessResult;
  renumber_restore_error?: string;
  effects_scope?: "observed";
  effects_unknown?: boolean;
  observed_windows?: string[];
  observed_panes?: string[];
  observation_error?: string;
};
type LoadInput = { path: string } & (
  | { kind: "native"; spec: WorkspaceSpec }
  | { kind: "extension"; spec: ExtensionSpec }
);

function option(value: Json): string {
  return typeof value === "boolean" ? (value ? "on" : "off") : scalarText(value);
}
function currentEndpoint(context: CLIContext): { socketPath: string; pid: string } | undefined {
  if (!context.env.TMUX) return undefined;
  const match = /^(.*),([0-9]+),[0-9]+$/s.exec(context.env.TMUX);
  if (!match?.[1]) throw new CliError("tmux_context", "TMUX does not identify a valid socket");
  return { socketPath: match[1], pid: match[2]! };
}
export function connection(values: Record<string, unknown>, context: CLIContext): Server {
  let path = values.socket_path ? expandPath(scalarText(values.socket_path), context) : undefined;
  if (!path && !values.socket_name) path = currentEndpoint(context)?.socketPath;
  const options: ConstructorParameters<typeof Server>[0] = {
    environment: { ...context.env, TMUX: undefined, TMUX_PANE: undefined },
    ...(path ? { socketPath: path } : {}),
    ...(values.socket_name && !values.socket_path
      ? { socketName: scalarText(values.socket_name) }
      : {}),
    ...(values.tmux_config_file ? { configFile: scalarText(values.tmux_config_file) } : {}),
    ...(values.colors ? { colors: values.colors as 256 } : {}),
    ...(context.env.TMUX_BIN ? { tmuxBin: context.env.TMUX_BIN } : {}),
  };
  return new Server(options);
}
function terminalArguments(server: Server): string[] {
  return [
    server.tmuxBin,
    ...(server.socketPath
      ? ["-S", server.socketPath]
      : server.socketName
        ? ["-L", server.socketName]
        : []),
  ];
}
async function currentSession(server: Server, context: CLIContext): Promise<BorrowedSession> {
  const endpoint = currentEndpoint(context);
  if (!endpoint || !context.env.TMUX_PANE)
    throw new CliError(
      "input_required",
      "This operation requires TMUX and TMUX_PANE from a current pane",
    );
  const acquisition = context.signal ? { signal: context.signal } : {};
  const [current, selected] = await Promise.all([
    connection({}, context).daemonIdentity(acquisition),
    server.snapshot(acquisition),
  ]);
  if (
    current.pid !== endpoint.pid ||
    current.pid !== selected.daemonIdentity.pid ||
    current.startTime !== selected.daemonIdentity.startTime
  )
    throw new CliError("tmux_context", "This operation must target the current pane's tmux server");
  const session = selected.panes.one({
    id: context.env.TMUX_PANE,
  }).session;
  if (!session)
    throw new CliError("input_required", "The current pane has no session on this server");
  return { session, daemon: selected.daemonIdentity };
}
async function attachmentClient(server: Server, context: CLIContext): Promise<string | undefined> {
  try {
    const terminal = await openTerminal(context);
    await terminal.close();
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw new CliError(
      "terminal_required",
      "Attached load needs a controlling terminal; pass -d",
      2,
    );
  }
  if (!currentEndpoint(context)) return undefined;
  const { session } = await currentSession(server, context);
  const query = await processRun(
    [...terminalArguments(server), "display-message", "-p", "#{client_name}"],
    {
      cwd: context.cwd,
      env: context.env,
      terminal: "input",
      ...(context.signal ? { signal: context.signal } : {}),
    },
  );
  const name = query.stdout.trim();
  const clients = (await server.snapshot(context.signal ? { signal: context.signal } : {})).clients;
  if (
    query.code !== 0 ||
    !clients.toArray().some((client) => client.name === name && client.session?.id === session.id)
  )
    throw new CliError("tmux_context", "The current pane has no attached client; pass -d");
  return name;
}
async function options(
  target: Session | Window,
  value: Json | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (value === undefined) return;
  for (const [name, data] of Object.entries(mapping(value, "options")))
    await target.setOption(name, option(data), signal ? { signal } : undefined);
}
async function send(pane: Pane, spec: PaneSpec, context: CLIContext): Promise<void> {
  let enter = spec.data.enter ?? true;
  let before = spec.data.sleep_before ?? null;
  let after = spec.data.sleep_after ?? null;
  for (const command of spec.commands) {
    context.signal?.throwIfAborted();
    if (command.enter !== undefined) enter = command.enter;
    if (command.sleep_before !== undefined) before = command.sleep_before;
    if (command.sleep_after !== undefined) after = command.sleep_after;
    if (before) await sleep(Number(before) * 1000, undefined, { signal: context.signal });
    await pane.sendKeys((spec.suppress ? " " : "") + command.cmd, {
      enter: Boolean(enter),
      literal: true,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (after) await sleep(Number(after) * 1000, undefined, { signal: context.signal });
  }
}
async function ready(pane: Pane, context: CLIContext): Promise<boolean> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const current = (
      await pane.server.snapshot(context.signal ? { signal: context.signal } : {})
    ).panes.one({ id: pane.id });
    if (Number(current.cursorX) !== 0 || Number(current.cursorY) !== 0) return true;
    await sleep(50, undefined, { signal: context.signal });
  }
  return false;
}
function freeIndex(occupied: ReadonlySet<number>, first: number): number {
  let index = first;
  while (occupied.has(index)) {
    if (index === 2147483647)
      throw new CliError("window_index_exhausted", `No free window index at or above ${first}`);
    index++;
  }
  return index;
}

async function removePlaceholder(
  session: Session,
  placeholder: Window,
  result: LoadResult,
): Promise<void> {
  const renumber = (await session.showResolvedOptions()).get("renumber-windows") === "on";
  const previous = renumber ? (await session.showOptions()).get("renumber-windows") : undefined;
  let failure: unknown;
  try {
    if (renumber) await session.setOption("renumber-windows", "off");
    await placeholder.kill();
    result.created_windows = result.created_windows.filter((id) => id !== placeholder.id);
    const removed = new Set<string>(placeholder.panes.toArray().map((pane) => pane.id));
    result.created_panes = result.created_panes.filter((id) => !removed.has(id));
  } catch (error) {
    failure = error;
  } finally {
    if (renumber) {
      try {
        if (previous === undefined) await session.unsetOption("renumber-windows");
        else await session.setOption("renumber-windows", previous);
      } catch (error) {
        result.renumber_restore_error = error instanceof Error ? error.message : String(error);
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
}

async function create(
  server: Server,
  spec: WorkspaceSpec,
  context: CLIContext,
  output: OperationOutput,
  result: LoadResult,
  existing?: Session,
  futureIndexes: ReadonlySet<number> = new Set(),
): Promise<Session> {
  const inputIndex = result.input_index;
  context.signal?.throwIfAborted();
  result.stage = existing ? "append" : "creating-session";
  const session =
    existing ??
    (await server.newSession({
      name: spec.name,
      ...(spec.directory ? { startDirectory: spec.directory } : {}),
      width: Number(context.env.COLUMNS ?? context.env.TMUXP_DEFAULT_COLUMNS ?? 80),
      height: Number(context.env.LINES ?? context.env.TMUXP_DEFAULT_ROWS ?? 24),
      ...(context.signal ? { signal: context.signal } : {}),
    }));
  result.session_id = session.id;
  result.session_name = session.name ?? spec.name;
  if (!existing) {
    const bootstrap = session.windows.at(0)!;
    result.created_windows.push(bootstrap.id);
    result.created_panes.push(...bootstrap.panes.toArray().map((pane) => pane.id));
  }
  result.completed_stages.push(existing ? "session-resolved" : "session-created");
  if (!existing)
    await output.event("session-created", {
      input_index: inputIndex,
      session_id: session.id,
      session_name: session.name,
    });
  if (spec.bootstrap) {
    result.stage = "before-script";
    try {
      const child = await processRun(spec.bootstrap, {
        cwd: spec.directory ?? context.cwd,
        env: context.env,
        ...(context.signal ? { signal: context.signal } : {}),
        output: async (stream, text) => {
          const handled = await output.event("script-output", {
            input_index: inputIndex,
            stream,
            text,
          });
          if (output.mode === "human" && !handled)
            await write(
              stream === "stdout" ? context.stdout : context.stderr,
              text,
              context.signal,
            );
        },
      });
      result.script_output = child;
      if (child.code !== 0)
        throw new CliError(
          "script_failed",
          `Bootstrap exited with status ${child.code}: ${child.stderr.trim()}`,
        );
      result.completed_stages.push("before-script");
    } catch (error) {
      if (!existing) {
        await session.kill();
        result.session_removed = true;
        result.completed_stages.push("session-removed");
      }
      throw error;
    }
  }
  result.stage = "session-options";
  await options(session, spec.data.options, context.signal);
  for (const [name, value] of Object.entries(
    spec.data.global_options ? mapping(spec.data.global_options) : {},
  ))
    await server.setGlobalOption(
      "session",
      name,
      option(value),
      context.signal ? { signal: context.signal } : undefined,
    );
  for (const [name, value] of Object.entries(spec.environment))
    await session.setEnvironment(
      name,
      value,
      context.signal ? { signal: context.signal } : undefined,
    );
  const wait =
    spec.windows.some((window) =>
      window.panes.some((pane) => !pane.shell && pane.commands.length > 0),
    ) &&
    (spec.readiness === "always" ||
      (spec.readiness === "auto" &&
        /(^|\/)zsh$/.test((await session.showResolvedOptions()).get("default-shell") ?? "")));
  result.completed_stages.push("session-options");
  result.stage = "window-allocation";
  const current = (await server.snapshot()).sessions.one({ id: session.id });
  const placeholder = existing
    ? undefined
    : current.windows.toArray().find((window) => window.id === session.windows.at(0)?.id);
  const occupied = new Set(
    current.windows
      .toArray()
      .filter((window) => window.id !== placeholder?.id)
      .map((window) => Number(window.index)),
  );
  const reserved = new Set([...occupied, ...futureIndexes]);
  for (const window of spec.windows) {
    if (window.index === undefined) continue;
    if (occupied.has(window.index))
      throw new CliError("window_index_conflict", `Window index ${window.index} already exists`);
    reserved.add(window.index);
  }
  let next = spec.windows.some((window) => window.index === undefined)
    ? Number((await session.showResolvedOptions()).get("base-index") ?? "0")
    : 0;
  const indexes = spec.windows.map((window) => {
    if (window.index !== undefined) return window.index;
    next = freeIndex(reserved, next);
    reserved.add(next);
    return next;
  });
  if (placeholder) {
    const spare = freeIndex(reserved, 0);
    if (Number(placeholder.index) !== spare) await placeholder.move({ index: spare });
  }
  let focusWindow: Window | undefined;
  for (const [windowIndex, desired] of spec.windows.entries()) {
    context.signal?.throwIfAborted();
    const first = desired.panes[0]!;
    result.stage = "creating-window";
    const window = await session.newWindow({
      index: indexes[windowIndex]!,
      ...(desired.name ? { name: desired.name } : {}),
      ...(first.directory ? { startDirectory: first.directory } : {}),
      ...(first.shell ? { shellCommand: first.shell } : {}),
      environment: first.environment,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    result.created_windows.push(window.id);
    result.created_panes.push(window.panes.at(0)!.id);
    if (windowIndex === 0 && placeholder) {
      result.stage = "bootstrap-removal";
      await removePlaceholder(session, placeholder, result);
    }
    result.stage = "window-options";
    await options(window, desired.data.options, context.signal);
    await output.event("window-created", {
      input_index: inputIndex,
      window_id: window.id,
      window_name: window.name,
      window_ordinal: windowIndex + 1,
      pane_total: desired.panes.length,
    });
    let previous = window.panes.at(0)!;
    let focusPane: Pane | undefined;
    for (const [paneIndex, paneSpec] of desired.panes.entries()) {
      context.signal?.throwIfAborted();
      result.stage = "creating-pane";
      const pane =
        paneIndex === 0
          ? previous
          : await previous.split({
              ...(paneSpec.directory ? { startDirectory: paneSpec.directory } : {}),
              ...(paneSpec.shell ? { shellCommand: paneSpec.shell } : {}),
              environment: paneSpec.environment,
              ...(context.signal ? { signal: context.signal } : {}),
            });
      if (paneIndex > 0) result.created_panes.push(pane.id);
      previous = pane;
      await output.event("pane-created", {
        input_index: inputIndex,
        pane_id: pane.id,
        window_id: window.id,
        pane_ordinal: paneIndex + 1,
      });
      if (paneSpec.commands.length > 0 && !paneSpec.shell && wait && !(await ready(pane, context)))
        await output.event("warning", {
          input_index: inputIndex,
          pane_id: pane.id,
          message: "Pane readiness timed out; sending commands",
        });
      if (desired.data.layout) await window.selectLayout(scalarText(desired.data.layout));
      result.stage = "pane-commands";
      await send(pane, paneSpec, context);
      await output.event("pane-completed", {
        input_index: inputIndex,
        pane_id: pane.id,
        window_id: window.id,
      });
      if (paneSpec.data.focus) focusPane = pane;
    }
    if (focusPane) await focusPane.select();
    result.stage = "window-options-after";
    await options(window, desired.data.options_after, context.signal);
    await output.event("window-completed", { input_index: inputIndex, window_id: window.id });
    if (desired.data.focus || !focusWindow) focusWindow = window;
  }
  if (focusWindow) await focusWindow.select();
  result.completed_stages.push("windows-created");
  return (await server.snapshot()).sessions.one({ id: session.id });
}
export async function load(request: Request, context: CLIContext): Promise<number> {
  if (request.values.colors === 88)
    throw new CliError(
      "unsupported_color_mode",
      "tmux 3.2a+ rejects the legacy 88-color flag (-8); remove it or use -2 for 256 colors",
      2,
    );
  if (request.mode !== "human" && !request.values.detached && !request.values.append)
    throw new CliError("usage", "Machine load requires -d or an explicit append operation", 2);
  const progress =
    request.mode === "human" && (context.stderr as { isTTY?: boolean }).isTTY
      ? (await import("./progress.ts")).LoadProgress.create(request, context)
      : undefined;
  const inputs: LoadInput[] = [];
  let bridge: typeof import("./extensions.ts") | undefined;
  const files = request.values.workspace_files as string[];
  for (const [index, input] of files.entries()) {
    const path = await resolveWorkspace(input, context);
    const document = await readDocument(path);
    const override =
      index === files.length - 1 && request.values.new_session_name
        ? scalarText(request.values.new_session_name)
        : undefined;
    if (
      ["plugins", "workspace_builder", "workspace_builder_paths"].some((key) =>
        Object.hasOwn(document, key),
      )
    )
      bridge ??= await import("./extensions.ts");
    const extension = await bridge?.extensionPlan(
      document,
      path,
      context,
      Boolean(request.values.append),
      override,
    );
    inputs.push(
      extension
        ? { path, kind: "extension", spec: extension }
        : { path, kind: "native", spec: normalize(document, path, context, override) },
    );
  }
  const python = inputs.some((input) => input.kind === "extension")
    ? await bridge!.extensionRuntime(context)
    : undefined;
  const server = connection(request.values, context);
  const attached = request.mode === "human" && !request.values.detached && !request.values.append;
  const client = attached ? await attachmentClient(server, context) : undefined;
  let append: Session | undefined;
  let borrowed: BorrowedSession | undefined;
  const futureIndexes = new Set<number>();
  if (request.values.append) {
    borrowed = await currentSession(server, context);
    append = borrowed.session;
    const reserved = new Set(append.windows.toArray().map((window) => Number(window.index)));
    for (const input of inputs) {
      if (input.kind !== "native") continue;
      for (const window of input.spec.windows)
        if (window.index !== undefined) {
          if (reserved.has(window.index))
            throw new CliError(
              "window_index_conflict",
              `Append cannot replace existing window index ${window.index}`,
            );
          reserved.add(window.index);
          futureIndexes.add(window.index);
        }
    }
  }
  const output = new OperationOutput(
    "load",
    request.mode,
    context.stdout,
    context.signal,
    async (event, data) => {
      const level =
        event === "failed"
          ? "error"
          : event === "warning"
            ? "warning"
            : ["started", "completed", "script-output", "workspace-completed"].includes(event)
              ? "info"
              : "debug";
      const echo = request.mode !== "human" || event !== "script-output";
      if (echo && context.diagnostics?.accepts(level)) await progress?.clear();
      await context.diagnostics?.record(level, event, data, echo);
      return progress?.event(event, data);
    },
  );
  const results: LoadResult[] = [];
  await output.event("started", { input_count: inputs.length });
  try {
    for (const [index, input] of inputs.entries()) {
      await output.event("workspace-started", {
        input_index: index,
        workspace: privatePath(input.path, context),
        session_name: input.spec.name,
        ...(input.kind === "native"
          ? {
              window_total: input.spec.windows.length,
              session_pane_total: input.spec.windows.reduce(
                (total, window) => total + window.panes.length,
                0,
              ),
            }
          : {}),
      });
      const result: LoadResult = {
        input_index: index,
        workspace: privatePath(input.path, context),
        session_name: input.spec.name,
        reused: false,
        appended: Boolean(append),
        stage: "session-lookup",
        completed_stages: [],
        created_windows: [],
        created_panes: [],
      };
      results.push(result);
      if (input.kind === "native")
        for (const window of input.spec.windows)
          if (window.index !== undefined) futureIndexes.delete(window.index);
      let session: Session;
      if (input.kind === "extension") {
        session = await bridge!.buildExtension(
          python!,
          input.spec,
          input.path,
          server,
          context,
          output,
          result,
          borrowed,
        );
      } else {
        result.reused = !append && (await server.hasSession(input.spec.name));
        session = result.reused
          ? (await server.snapshot()).sessions.one({ name: input.spec.name })
          : await create(server, input.spec, context, output, result, append, futureIndexes);
      }
      result.session_id = session.id;
      result.session_name = session.name ?? input.spec.name;
      result.stage = "completed";
      await output.event("workspace-completed", result);
      if (request.mode === "human") {
        const color = colorEnabled(
          request.mode,
          request.values.color,
          context.env,
          Boolean((context.stdout as { isTTY?: boolean }).isTTY),
        );
        await write(
          context.stdout,
          `${styled("success", result.reused ? "Reused" : append ? "Appended" : "Loaded", color)} ${styled("subject", session.name, color)}\n`,
          context.signal,
        );
      }
    }
    const last = results.at(-1);
    if (attached && last?.session_id) {
      last.stage = client ? "switching-client" : "attaching";
      const args = terminalArguments(server);
      if (request.values.colors === 256) args.push("-2");
      args.push(
        ...(client ? ["switch-client", "-c", client] : ["attach-session"]),
        "-t",
        last.session_id,
      );
      const child = await processRun(args, {
        cwd: context.cwd,
        env: context.env,
        terminal: client ? "input" : true,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (child.code !== 0)
        throw new CliError(
          "attach_failed",
          `tmux attachment failed${child.stderr.trim() ? ": " + child.stderr.trim() : ""}`,
          child.code,
        );
      last.stage = "completed";
    }
    await output.result({ status: "ok", results, errors: [] });
    return 0;
  } catch (error) {
    if (output.isFinished) throw error;
    const interrupted = context.signal?.aborted;
    const changed = results.some(
      (result) =>
        result.effects_unknown ||
        result.stage === "completed" ||
        (result.session_id && !result.session_removed),
    );
    await output.result({
      status: changed ? "partial" : "error",
      results,
      errors: [
        {
          code: interrupted
            ? "interrupted"
            : error instanceof CliError
              ? error.code
              : "load_failed",
          message: error instanceof Error ? error.message : String(error),
          input_index: results.at(-1)?.input_index ?? 0,
          failed_stage: results.at(-1)?.stage ?? "started",
        },
      ],
    });
    if (request.mode === "human") {
      for (const result of results)
        if (result.session_id && !result.session_removed)
          await write(
            context.stderr,
            `Session ${styled("subject", result.session_name, false)} remains available (${result.stage}).\n`,
            context.signal,
          );
      throw error;
    }
    return interrupted ? 130 : 1;
  } finally {
    await progress?.clear(AbortSignal.timeout(100)).catch(() => {});
  }
}
async function freezeSession(
  server: Server,
  request: Request,
  context: CLIContext,
): Promise<Session> {
  const name = request.values.session_name;
  const explicit = name !== null && name !== undefined;
  if (!explicit && context.env.TMUX) return (await currentSession(server, context)).session;
  const acquisition = context.signal ? { signal: context.signal } : {};
  const sessions = (await server.snapshot(acquisition)).sessions.toArray();
  if (explicit) {
    const target = scalarText(name);
    const session = sessions.find((item) => item.name === target || item.id === target);
    if (!session) throw new CliError("session_not_found", `Session not found: ${target}`);
    return session;
  }
  if (sessions.length === 1) return sessions[0]!;
  if (!sessions.length) throw new CliError("session_not_found", "No live sessions to capture");
  throw new CliError(
    "input_required",
    "Several sessions are available; specify a session name or ID to freeze",
    2,
  );
}

export async function freeze(request: Request, context: CLIContext): Promise<number> {
  const server = connection(request.values, context);
  const session = await freezeSession(server, request, context);
  const acquisition = context.signal ? { signal: context.signal } : {};
  const windows: Document[] = [];
  for (const window of session.windows.toArray()) {
    const panes = window.panes.toArray().map((pane) => ({
      shell_command: [],
      start_directory: pane.currentPath ?? context.cwd,
      ...(pane.active === true ? { focus: true } : {}),
    }));
    const options = Object.fromEntries(await window.showOptions(acquisition));
    windows.push({
      window_name: window.name,
      window_index: Number(window.index),
      layout: window.layout,
      options,
      panes,
      ...(window.active === true ? { focus: true } : {}),
    });
  }
  const document: Document = {
    session_name: session.name,
    windows,
    options: Object.fromEntries(await session.showOptions(acquisition)),
  };
  const destination = request.values.save_to
    ? resolve(context.cwd, scalarText(request.values.save_to))
    : undefined;
  const format = scalarText(
    request.values.workspace_format ??
      (destination && extname(destination).toLowerCase() === ".json" ? "json" : "yaml"),
  );
  if (!destination && request.mode === "human")
    throw new CliError(
      "input_required",
      "Specify --save-to or choose --json/--ndjson capture output",
    );
  if (destination)
    await saveDocument(
      document,
      destination,
      format,
      Boolean(request.values.force),
      context.signal,
    );
  if (request.mode === "json")
    await emitJson(
      context.stdout,
      destination
        ? {
            schema_version: 1,
            command: "freeze",
            status: "ok",
            destination: privatePath(destination, context),
            format,
          }
        : document,
      true,
      context.signal,
    );
  else if (request.mode === "ndjson")
    await emitJson(
      context.stdout,
      {
        schema_version: 1,
        command: "freeze",
        status: "ok",
        ...(destination
          ? { destination: privatePath(destination, context), format }
          : { workspace: document }),
      },
      false,
      context.signal,
    );
  else if (!request.values.quiet)
    await write(context.stdout, `Saved ${destination}\n`, context.signal);
  return 0;
}
