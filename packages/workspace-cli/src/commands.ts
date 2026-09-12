/* eslint-disable no-await-in-loop -- Diagnostic fields render in order to the same stream. */
import { platform, release } from "node:os";
import manifest from "../package.json" with { type: "json" };
import type { CLIContext } from "./app.ts";
import { scalarText, privatePath, resolveWorkspace } from "./documents.ts";
import { CliError, colorEnabled, emitJson, OperationOutput, styled, write } from "./output.ts";
import type { Request } from "./parser.ts";
import { processRun, tokenize } from "./process.ts";

function tty(context: CLIContext): boolean {
  return Boolean((context.stdin as { isTTY?: boolean }).isTTY);
}

export async function edit(request: Request, context: CLIContext): Promise<number> {
  const file = await resolveWorkspace(scalarText(request.values.workspace_file), context);
  const argv = [...tokenize(context.env.EDITOR || "vi"), file];
  const child = await processRun(argv, {
    cwd: context.cwd,
    env: context.env,
    terminal: tty(context),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(request.mode === "human"
      ? {
          output: async (stream: "stdout" | "stderr", text: string) => {
            await write(context[stream], text, context.signal);
          },
        }
      : {}),
  });
  if (request.mode !== "human")
    await emitJson(
      context.stdout,
      {
        schema_version: 1,
        command: "edit",
        status: child.code ? "error" : "ok",
        file: privatePath(file, context),
        child_status: child.code,
        stdout: child.stdout,
        stderr: child.stderr,
        truncated: child.truncated,
        encoding: "utf-8-with-replacement",
      },
      false,
      context.signal,
    );
  return child.code;
}

export async function debugInfo(request: Request, context: CLIContext): Promise<number> {
  let tmux: { version: string | null; error?: string };
  try {
    const result = await processRun([context.env.TMUX_BIN || "tmux", "-V"], {
      cwd: context.cwd,
      env: context.env,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    tmux = result.code
      ? { version: null, error: result.stderr.trim() }
      : { version: result.stdout.trim() };
  } catch (error) {
    tmux = { version: null, error: String(error) };
  }
  const document = {
    port: "typescript",
    version: manifest.version,
    platform: platform(),
    release: release(),
    cwd: privatePath(context.cwd, context),
    runtime: {
      name: process.versions.bun ? "Bun" : "Node.js",
      version: process.versions.bun ?? process.versions.node,
    },
    tmux,
    paths: Object.fromEntries(
      ["TMUXP_CONFIGDIR", "XDG_CONFIG_HOME", "SHELL", "TMUX_BIN", "TMUX_WORKSPACE_PYTHON"].flatMap(
        (key) => (context.env[key] ? [[key, privatePath(context.env[key], context)]] : []),
      ),
    ),
  };
  if (request.mode !== "human")
    await emitJson(context.stdout, document, request.mode === "json", context.signal);
  else {
    const color = colorEnabled(
      request.mode,
      request.values.color,
      context.env,
      Boolean((context.stdout as { isTTY?: boolean }).isTTY),
    );
    await write(
      context.stdout,
      styled("heading", "Workspace diagnostics", color) + "\n",
      context.signal,
    );
    for (const [label, value] of Object.entries(document))
      await write(
        context.stdout,
        `${styled("subject", label, color)}: ${styled("info", typeof value === "string" ? value : JSON.stringify(value), color)}\n`,
        context.signal,
      );
  }
  return 0;
}

export async function shell(request: Request, context: CLIContext): Promise<number> {
  const interactive = request.values.command === null || request.values.command === undefined;
  if (interactive && !tty(context))
    throw new CliError(
      "terminal_required",
      "An interactive Python shell needs a terminal; use -c for captured output",
    );
  const python = context.env.TMUX_WORKSPACE_PYTHON || "python3";
  const signal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  try {
    const check = await processRun(
      [python, "-c", "import importlib.metadata; print(importlib.metadata.version('tmuxp'))"],
      { cwd: context.cwd, env: context.env, signal },
    );
    if (check.code || check.stdout.trim() !== "1.74.0") throw new Error("Requires tmuxp 1.74.0");
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw new CliError(
      "python_runtime",
      "The Python bridge requires tmuxp 1.74.0; set TMUX_WORKSPACE_PYTHON to its interpreter",
    );
  }
  const args = [
    python,
    "-u",
    "-c",
    "from tmuxp.cli import cli; cli()",
    "--color",
    "never",
    "shell",
  ];
  for (const [name, flag] of [
    ["socket_path", "-S"],
    ["socket_name", "-L"],
    ["command", "-c"],
  ] as const) {
    const value = request.values[name];
    if (value !== null && value !== undefined) args.push(flag, scalarText(value));
  }
  if (request.values.shell) args.push(`--${scalarText(request.values.shell)}`);
  args.push(
    request.values.use_pythonrc ? "--use-pythonrc" : "--no-startup",
    request.values.use_vi_mode ? "--use-vi-mode" : "--no-vi-mode",
  );
  for (const key of ["session_name", "window_name"])
    if (request.values[key]) args.push(scalarText(request.values[key]));
  const output = new OperationOutput("shell", request.mode, context.stdout, context.signal);
  const child = await processRun(args, {
    cwd: context.cwd,
    env: context.env,
    terminal: interactive,
    ...(context.signal ? { signal: context.signal } : {}),
    output: async (stream, text) => {
      if (request.mode === "human") await write(context[stream], text, context.signal);
      else
        await output.event("script-output", { stream, text, encoding: "utf-8-with-replacement" });
    },
  });
  await output.result({
    status: child.code ? "error" : "ok",
    child_status: child.code,
    stdout: child.stdout,
    stderr: child.stderr,
    truncated: child.truncated,
    encoding: "utf-8-with-replacement",
  });
  return child.code;
}
