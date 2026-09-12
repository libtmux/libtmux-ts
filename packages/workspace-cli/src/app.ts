/* eslint-disable no-await-in-loop -- Output follows record order and awaits stream backpressure. */
import { load, freeze } from "./tmux.ts";
import type { Readable, Writable } from "node:stream";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CommanderError } from "commander";
import { createParser } from "./parser.ts";
import {
  scalarText,
  discover,
  expandPath,
  home,
  importDocument,
  privatePath,
  readDocument,
  resolveWorkspace,
  saveDocument,
  type FileContext,
} from "./documents.ts";
import { CliError, colorEnabled, emitJson, styled, write } from "./output.ts";
import { search } from "./search.ts";
import { debugInfo, edit, shell } from "./commands.ts";
import { Diagnostics } from "./diagnostics.ts";

export type CLIContext = FileContext & {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable;
  signal?: AbortSignal;
  diagnostics?: Diagnostics;
};

export async function run(argv: string[], context: CLIContext): Promise<number> {
  let diagnostics: Diagnostics | undefined;
  let help = "";
  let parserError = "";
  const parser = createParser({
    stdout: (text) => {
      help += text;
    },
    stderr: (text) => {
      parserError += text;
    },
  });
  const positional = argv.indexOf("--");
  const options = positional < 0 ? argv : argv.slice(0, positional);
  let mode = options.includes("--ndjson")
    ? "ndjson"
    : options.includes("--json")
      ? "json"
      : "human";
  const report = async (code: string, message: string) => {
    const text =
      mode === "human"
        ? `tmux-workspace: ${message}\n`
        : JSON.stringify({ schema_version: 1, code, message }) + "\n";
    await write(context.stderr, text, context.signal);
  };
  const reportLogFailure = async (error: unknown) => {
    try {
      await report("log_error", error instanceof Error ? error.message : String(error));
    } catch {
      // A failed or cancelled diagnostic sink cannot report its own failure.
    }
  };
  try {
    try {
      parser.command.parse(argv, { from: "user" });
    } catch (error) {
      if (error instanceof CommanderError && error.exitCode === 0) {
        await write(context.stdout, help, context.signal);
        return 0;
      }
      throw error;
    }
    const request = parser.request();
    mode = request.mode;
    diagnostics = await Diagnostics.open(request.values, request.mode, context);
    context = { ...context, diagnostics };
    context.signal?.throwIfAborted();
    await diagnostics.record("debug", "command-started", { command: request.command });
    const color = colorEnabled(
      request.mode,
      request.values.color,
      context.env,
      Boolean((context.stdout as Writable & { isTTY?: boolean }).isTTY),
    );
    const render = (role: Parameters<typeof styled>[0], value: unknown) =>
      styled(role, value, color);
    if (!request.command || request.command === "import") {
      await write(
        context.stdout,
        parser.commands.get(request.command)!.helpInformation(),
        context.signal,
      );
      return 0;
    }
    if (request.command === "load") return await load(request, context);
    if (request.command === "freeze") return await freeze(request, context);
    if (request.command === "edit") return await edit(request, context);
    if (request.command === "debug-info") return await debugInfo(request, context);
    if (request.command === "shell") return await shell(request, context);
    if (request.command === "ls") {
      const result = await discover(context, Boolean(request.values.full));
      if (mode === "json") await emitJson(context.stdout, result, true, context.signal);
      else if (mode === "ndjson")
        for (const record of result.workspaces)
          await emitJson(context.stdout, record, false, context.signal);
      else {
        let heading = "";
        for (const record of result.workspaces) {
          const group = request.values.tree
            ? dirname(record.path)
            : `${record.source === "local" ? "Local" : "Global"} workspaces`;
          if (group !== heading) {
            await write(context.stdout, render("heading", group) + ":\n", context.signal);
            heading = group;
          }
          await write(
            context.stdout,
            `  ${render("subject", record.name)}  ${render("info", record.path)}\n`,
            context.signal,
          );
          if (request.values.full && record.config)
            await write(
              context.stdout,
              JSON.stringify(record.config, null, 2) + "\n",
              context.signal,
            );
        }
        if (!result.workspaces.length)
          await write(
            context.stdout,
            render("warning", "No workspaces found.") + "\n",
            context.signal,
          );
        await write(
          context.stdout,
          "\n" + render("heading", "Global workspace directories:") + "\n",
          context.signal,
        );
        for (const entry of result.global_workspace_dirs)
          await write(
            context.stdout,
            `  ${render("secondary", entry.source)}: ${render("info", entry.path)} (${render(entry.active ? "success" : "secondary", entry.exists ? `${entry.workspace_count} workspaces${entry.active ? ", active" : ""}` : "not found")})\n`,
            context.signal,
          );
      }
      return 0;
    }
    if (request.command === "search") {
      const results = await search(request.values, context);
      if (mode === "json") await emitJson(context.stdout, results, true, context.signal);
      else if (mode === "ndjson")
        for (const result of results) await emitJson(context.stdout, result, false, context.signal);
      else
        for (const result of results)
          await write(
            context.stdout,
            `${render("subject", result.name)}  ${render("info", result.path)}  ${render("secondary", (result.matched_fields as string[]).join(", "))}\n`,
            context.signal,
          );
      return 0;
    }
    if (request.command === "convert" || request.command.startsWith("import ")) {
      const kind = request.command.split(" ")[1] as "teamocil" | "tmuxinator" | undefined;
      let importerRoot: string | undefined;
      if (kind === "teamocil") importerRoot = join(home(context), ".teamocil");
      else if (kind === "tmuxinator")
        importerRoot = expandPath(
          context.env.TMUXINATOR_CONFIG ?? join(home(context), ".tmuxinator"),
          context,
        );
      const source = await resolveWorkspace(
        scalarText(request.values.workspace_file),
        context,
        importerRoot,
      );
      const raw = await readDocument(source);
      const document = kind ? importDocument(kind, raw) : raw;
      let destination = request.values.save_to
        ? resolve(context.cwd, expandPath(scalarText(request.values.save_to), context))
        : undefined;
      const format = scalarText(
        request.values.workspace_format ?? (extname(source) === ".json" ? "yaml" : "json"),
      );
      if (!destination && mode === "human") {
        if (!request.values.answer_yes)
          throw new CliError(
            "input_required",
            "Confirm conversion with --yes or provide --save-to",
          );
        destination = join(
          dirname(source),
          basename(source, extname(source)) + (format === "json" ? ".json" : ".yaml"),
        );
      }
      if (destination) {
        await saveDocument(document, destination, format, Boolean(request.values.force));
        const result = {
          schema_version: 1,
          command: request.command,
          status: "ok",
          destination: privatePath(destination, context),
          format,
        };
        if (mode === "human")
          await write(
            context.stdout,
            `${render("success", "Saved")} ${render("info", destination)}\n`,
            context.signal,
          );
        else await emitJson(context.stdout, result, false, context.signal);
      } else if (mode === "json") await emitJson(context.stdout, document, true, context.signal);
      else
        await emitJson(
          context.stdout,
          {
            schema_version: 1,
            command: request.command,
            status: "ok",
            workspace: document,
          },
          false,
          context.signal,
        );
      return 0;
    }
    throw new CliError("not_implemented", `${request.command} service is not implemented yet`);
  } catch (error) {
    if (context.signal?.aborted) return 130;
    const usage = error instanceof CommanderError;
    const code = usage ? "usage" : error instanceof CliError ? error.code : "workspace_error";
    const message = usage
      ? parserError.trim() || error.message
      : error instanceof Error
        ? error.message
        : String(error);
    try {
      await report(code, message);
    } catch {
      // Preserve the command failure when stderr has also closed.
    }
    try {
      await diagnostics?.record("error", "command-failed", { code, message }, false);
    } catch (logError) {
      await reportLogFailure(logError);
    }
    return context.signal?.aborted
      ? 130
      : usage
        ? 2
        : error instanceof CliError
          ? error.exitCode
          : 1;
  } finally {
    try {
      await diagnostics?.close();
    } catch (error) {
      await reportLogFailure(error);
    }
  }
}
