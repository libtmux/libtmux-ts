import { join, resolve } from "node:path";
import { type Document, type FileContext, type Json, mapping, sequence } from "./documents.ts";
import { expand, normalize } from "./normalize.ts";

function fields(value: Document, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unsupported import field: ${path}.${key}`);
}

function alias(value: Document, current: string, legacy: string, path: string): Json | undefined {
  if (
    value[current] !== undefined &&
    value[current] !== null &&
    value[legacy] !== undefined &&
    value[legacy] !== null
  )
    throw new Error(`Choose ${path}.${current} or ${path}.${legacy}`);
  return value[current] ?? value[legacy];
}

function strings(value: Json | undefined, path: string): string[] {
  if (value === undefined || value === null) return [];
  const entries = typeof value === "string" ? [value] : sequence(value, path);
  return entries.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${path} must contain strings`);
    return entry;
  });
}

function commands(value: Json | undefined, path: string, separator?: string): Json[] {
  const entries = strings(value, path);
  return (separator && entries.length ? [entries.join(separator)] : entries).map((cmd) => ({
    cmd,
  }));
}

function directory(value: Json | undefined, base: string, context: FileContext): string {
  if (value === undefined || value === null) return base;
  if (typeof value !== "string") throw new Error("Imported root must be a string");
  return resolve(base, expand(value, context));
}

function copy(source: Document, target: Document, names: readonly string[]): void {
  for (const name of names)
    if (source[name] !== undefined) target[name] = structuredClone(source[name]!);
}

function focusFirst(items: Document[]): void {
  const selected = items.findIndex((item) => item.focus === true);
  for (const [index, item] of items.entries()) {
    if (item.focus !== undefined && typeof item.focus !== "boolean")
      throw new Error("Imported focus must be boolean");
    if (index === (selected < 0 ? 0 : selected)) item.focus = true;
    else delete item.focus;
  }
}

function teamocil(source: Document, context: FileContext): Document {
  if (source.session !== undefined) fields(source, ["session"], "teamocil");
  const session = mapping(source.session ?? source, "teamocil session");
  fields(session, ["name", "root", "windows", "description"], "session");
  const root = directory(session.root, context.cwd, context);
  const windows = sequence(session.windows, "session.windows").map((value, ordinal) => {
    const path = `session.windows[${ordinal}]`;
    const window = mapping(value, path);
    fields(
      window,
      ["name", "root", "layout", "focus", "options", "panes", "splits", "description"],
      path,
    );
    const result: Document = { window_name: window.name ?? null };
    copy(window, result, ["layout", "focus", "options", "description"]);
    if (window.root !== undefined) result.start_directory = directory(window.root, root, context);
    const panes = sequence(alias(window, "panes", "splits", path) ?? [null], `${path}.panes`).map(
      (value, index) => {
        const panePath = `${path}.panes[${index}]`;
        if (typeof value === "string" || value === null)
          return { shell_command: commands(value, panePath) } as Document;
        const pane = mapping(value, panePath);
        fields(pane, ["commands", "cmd", "focus", "description"], panePath);
        const result: Document = {
          shell_command: commands(alias(pane, "commands", "cmd", panePath), panePath, "; "),
        };
        copy(pane, result, ["focus", "description"]);
        return result;
      },
    );
    focusFirst(panes);
    result.panes = panes;
    return result;
  });
  focusFirst(windows);
  const result: Document = { session_name: session.name ?? null, start_directory: root, windows };
  copy(session, result, ["description"]);
  return result;
}

function tmuxinator(source: Document, context: FileContext): Document {
  fields(
    source,
    [
      "name",
      "project_name",
      "root",
      "project_root",
      "windows",
      "tabs",
      "pre_window",
      "description",
    ],
    "tmuxinator",
  );
  const root = directory(alias(source, "root", "project_root", "tmuxinator"), context.cwd, context);
  const windows = sequence(alias(source, "windows", "tabs", "tmuxinator"), "windows").map(
    (value, ordinal) => {
      const path = `windows[${ordinal}]`;
      const entries = Object.entries(mapping(value, path));
      if (entries.length !== 1) throw new Error(`${path} needs exactly one window name`);
      const [name, definition] = entries[0]!;
      const result: Document = { window_name: name };
      let panes: Document[];
      if (typeof definition === "string" || definition === null || Array.isArray(definition)) {
        panes = [{ shell_command: commands(definition, path) }];
      } else {
        const window = mapping(definition, path);
        fields(window, ["root", "layout", "pre", "panes", "synchronize", "description"], path);
        if (window.pre !== undefined && (!Array.isArray(window.panes) || window.panes.length === 0))
          throw new Error(`${path}.pre requires explicit panes`);
        copy(window, result, ["layout", "description"]);
        if (window.root !== undefined)
          result.start_directory = directory(window.root, root, context);
        if (window.pre !== undefined)
          result.shell_command_before = commands(window.pre, `${path}.pre`, " && ");
        if (window.synchronize !== undefined) {
          const value = window.synchronize;
          if (![true, false, "before", "after"].includes(value as boolean | string))
            throw new Error(`${path}.synchronize must be boolean, before, or after`);
          result[value === "after" ? "options_after" : "options"] = {
            "synchronize-panes": value !== false,
          };
        }
        panes = sequence(window.panes ?? [null], `${path}.panes`).map((pane, index) => ({
          shell_command: commands(pane, `${path}.panes[${index}]`),
        }));
      }
      focusFirst(panes);
      result.panes = panes;
      return result;
    },
  );
  focusFirst(windows);
  const result: Document = {
    session_name: alias(source, "name", "project_name", "tmuxinator") ?? null,
    start_directory: root,
    windows,
  };
  if (source.pre_window !== undefined)
    result.shell_command_before = commands(source.pre_window, "pre_window", "; ");
  copy(source, result, ["description"]);
  return result;
}

export function importDocument(
  kind: "teamocil" | "tmuxinator",
  source: Document,
  context: FileContext,
): Document {
  if (kind === "tmuxinator" && JSON.stringify(source).includes("<%"))
    throw new Error("tmuxinator ERB templates are unsupported; expand them before import");
  const result = kind === "teamocil" ? teamocil(source, context) : tmuxinator(source, context);
  normalize(result, join(context.cwd, "imported.json"), context);
  return result;
}
