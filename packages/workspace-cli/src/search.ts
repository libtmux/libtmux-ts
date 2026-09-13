import { discover, type FileContext, type Json, type WorkspaceRecord } from "./documents.ts";
import { CliError } from "./output.ts";

const aliases: Record<string, string> = {
  name: "name",
  n: "name",
  session: "session_name",
  session_name: "session_name",
  s: "session_name",
  path: "path",
  p: "path",
  window: "window",
  w: "window",
  pane: "pane",
};
const defaultFields = ["name", "session_name", "path", "window", "pane"];
function fields(selected: unknown): string[] {
  if (!selected) return defaultFields;
  return [
    ...new Set(
      (selected as string[]).map((item) => {
        const name = aliases[item.toLowerCase()];
        if (!name) throw new CliError("usage", `Unknown search field: ${item}`, 2);
        return name;
      }),
    ),
  ];
}
function extract(record: WorkspaceRecord): Record<string, string[]> {
  const result: Record<string, string[]> = {
    name: [record.name],
    path: [record.path],
    session_name: [pythonString(record.session_name ?? "")],
    window: [],
    pane: [],
  };
  const windows = record.config?.windows;
  if (!Array.isArray(windows)) return result;
  for (const window of windows) {
    if (!window || typeof window !== "object" || Array.isArray(window)) continue;
    if (window.window_name) result.window!.push(pythonString(window.window_name));
    if (Array.isArray(window.panes))
      for (const pane of window.panes) {
        if (typeof pane === "string") result.pane!.push(pane);
        else if (pane && typeof pane === "object" && !Array.isArray(pane)) {
          const commands = pane.shell_command;
          if (typeof commands === "string") result.pane!.push(commands);
          else if (Array.isArray(commands))
            result.pane!.push(...commands.filter(Boolean).map(pythonString));
        }
      }
  }
  return result;
}
function pythonString(value: Json): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(pythonString).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .map(
        ([key, value]) =>
          `'${key}': ${typeof value === "string" ? `'${value}'` : pythonString(value)}`,
      )
      .join(", ")}}`;
  return String(value);
}
export async function search(
  values: Record<string, unknown>,
  context: FileContext,
): Promise<Record<string, unknown>[]> {
  const selected = fields(values.field);
  const queries = ((values.query_terms ?? []) as string[])
    .filter(Boolean)
    .map((term) => {
      const colon = term.indexOf(":");
      const prefixed = colon > 0 ? aliases[term.slice(0, colon).toLowerCase()] : undefined;
      const pattern = prefixed ? term.slice(colon + 1) : term;
      return { fields: prefixed ? [prefixed] : selected, pattern };
    })
    .filter((term) => term.pattern);
  if (!queries.length) throw new CliError("usage", "Provide at least one search pattern", 2);
  const patterns = queries.map((query) => {
    let expression = values.fixed_strings
      ? query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : query.pattern;
    if (values.word_regexp) expression = `\\b(?:${expression})\\b`;
    try {
      return {
        fields: query.fields,
        regex: new RegExp(
          expression,
          values.ignore_case || (values.smart_case && !/\p{Lu}/u.test(query.pattern)) ? "iu" : "u",
        ),
      };
    } catch (error) {
      throw new CliError("usage", `Invalid search pattern: ${(error as Error).message}`, 2);
    }
  });
  const { workspaces } = await discover(context, true);
  const results: Record<string, unknown>[] = [];
  for (const record of workspaces) {
    const extracted = extract(record);
    const matches: Record<string, string[]> = {};
    const outcomes = patterns.map((pattern) => {
      let found = false;
      for (const field of pattern.fields)
        for (const value of extracted[field] ?? []) {
          const match = pattern.regex.exec(value);
          if (match) {
            found = true;
            (matches[field] ??= []).push(match[0]);
          }
        }
      return found;
    });
    const matched = values.match_any ? outcomes.some(Boolean) : outcomes.every(Boolean);
    if (values.invert_match ? matched : !matched) continue;
    results.push({
      name: record.name,
      path: record.path,
      session_name: record.session_name ?? "",
      source: record.source,
      matched_fields: Object.keys(matches),
      matches,
    });
  }
  return results;
}
