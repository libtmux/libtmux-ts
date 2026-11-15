import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDocument, type Document } from "../src/documents.ts";
import { normalize, type CommandSpec, type WorkspaceSpec } from "../src/normalize.ts";

/**
 * What each of tmuxp's example workspace files means once the loader has read
 * it: the session, windows, panes, layouts, directories, environment and the
 * commands in the order they are sent.
 *
 * The structures in `fixtures/tmuxp-examples/expected/` are written by hand
 * from what tmuxp documents for each example (see the README there). No tmuxp
 * or Python runs here. A file that loads into something else is a bug to fix,
 * or a difference the README there records with its reason.
 *
 * Nothing here starts tmux: `tmuxp-examples.test.ts` builds every file on a
 * real server.
 */

const fixtures = new URL("./fixtures/tmuxp-examples/", import.meta.url).pathname.replace(
  /\/$/u,
  "",
);
const workspaceDirectory = fixtures;
const home = "/home/u";
/** The variables the catalog's files read; `HOME` and the file's directory are placeholders in the expected files. */
const context = {
  cwd: "/work",
  env: { HOME: home, MAIN_PANE_HEIGHT: "30", MY_ENV_VAR: "/scripts", PWD: "/work", USER: "tmuxp" },
};

/** tmuxp's example the loader cannot read on its own: `plugins` runs through tmuxp's Python. */
const needsPython = ["plugin-system.yaml"];

type Tree = {
  session: Record<string, unknown>;
  windows: { index: number | null; panes: Record<string, unknown>[]; [key: string]: unknown }[];
};

function command(spec: CommandSpec): string | Record<string, unknown> {
  const { cmd, ...attributes } = spec;
  return Object.keys(attributes).length === 0 ? cmd : { cmd, ...attributes };
}

/** The loaded model in the shape of the expected files. */
function structure(spec: WorkspaceSpec): Tree {
  const taken = new Set(
    spec.windows.flatMap((window) => (window.index === undefined ? [] : [window.index])),
  );
  let next = 0;
  const session: Record<string, unknown> = {
    name: spec.name,
    start_directory: spec.directory ?? null,
    environment: spec.environment,
    options: spec.data.options ?? {},
  };
  if (spec.data.global_options !== undefined) session.global_options = spec.data.global_options;
  if (spec.bootstrap !== undefined) session.before_script = spec.bootstrap;
  return {
    session,
    windows: spec.windows.map((window) => {
      // tmux gives a window with no index the lowest free one.
      let index = window.index;
      if (index === undefined) {
        while (taken.has(next)) next += 1;
        index = next;
        taken.add(index);
      }
      const loaded: Tree["windows"][number] = {
        name: window.name ?? null,
        index,
        layout: window.data.layout ?? null,
        focus: Boolean(window.data.focus),
        start_directory: window.directory ?? null,
        options: window.data.options ?? {},
        panes: window.panes.map((pane) => {
          const loadedPane: Record<string, unknown> = {
            focus: Boolean(pane.data.focus),
            start_directory: pane.directory ?? null,
            environment: pane.environment,
            commands: pane.commands.map(command),
          };
          for (const key of ["enter", "sleep_before", "sleep_after"] as const) {
            if (pane.data[key] !== undefined) loadedPane[key] = pane.data[key];
          }
          if (pane.shell !== undefined) loadedPane.shell = pane.shell;
          if (!pane.suppress) loadedPane.suppress_history = false;
          return loadedPane;
        }),
      };
      if (window.data.options_after !== undefined) loaded.options_after = window.data.options_after;
      return loaded;
    }),
  };
}

async function load(file: string): Promise<Tree> {
  const path = join(fixtures, file);
  return structure(normalize(await readDocument(path), path, context));
}

async function expected(file: string): Promise<Tree> {
  const text = await readFile(
    join(fixtures, "expected", file.replace(/\.yaml$/u, ".json")),
    "utf8",
  );
  const { source: _source, ...tree } = JSON.parse(
    text.replaceAll("${WORKSPACE_DIR}", workspaceDirectory).replaceAll("${HOME}", home),
  ) as Tree & { source: string };
  return tree;
}

const catalog = (await readdir(fixtures)).filter((name) => name.endsWith(".yaml")).sort();
const loaded = catalog.filter((name) => !needsPython.includes(name));

test("every tmuxp example has one expected structure, except the one that needs Python", async () => {
  const written = (await readdir(join(fixtures, "expected"))).sort();
  expect(written).toEqual(loaded.map((name) => name.replace(/\.yaml$/u, ".json")));
  expect(catalog.length).toBeGreaterThanOrEqual(20);
  for (const name of needsPython) expect(catalog).toContain(name);
});

test.each(loaded)("%s loads into the structure tmuxp documents for it", async (file) => {
  expect(await load(file)).toEqual(await expected(file));
});

test("the comparison reports a wrong structure", async () => {
  const tree = await load("3-pane.yaml");
  expect(tree).toEqual(await expected("3-pane.yaml"));
  const wrong = async (change: (copy: Tree) => void): Promise<Tree> => {
    const copy = structuredClone(await expected("3-pane.yaml"));
    change(copy);
    return copy;
  };
  for (const changed of [
    await expected("4-pane.yaml"),
    await wrong((copy) => (copy.windows[0]!.layout = "tiled")),
    await wrong((copy) => (copy.windows[0]!.panes[1]!.focus = true)),
    await wrong((copy) => (copy.windows[0]!.panes[2]!.commands as string[]).push("x")),
    await wrong((copy) => (copy.windows[0]!.panes[0]!.start_directory = "/tmp")),
  ]) {
    expect(tree).not.toEqual(changed);
  }
});

type SyntaxEntry = {
  id: string;
  scope: string;
  key: string;
  form: string;
  probe: string[];
  status: "difference" | "refused" | "supported";
  message?: string;
  difference?: string;
  observed?: { path: (string | number)[]; value: unknown };
};
type SyntaxRecord = { statuses: Record<string, string>; entries: SyntaxEntry[] };

const syntax = JSON.parse(
  await readFile(join(fixtures, "syntax-support.json"), "utf8"),
) as SyntaxRecord;

/** Read a probe as `/workspace/w.yaml`, the way every entry in the record is. */
async function parse(probe: readonly string[]): Promise<WorkspaceSpec> {
  const { parse: parseYaml } = await import("yaml");
  return normalize(
    parseYaml(`${probe.join("\n")}\n`, { merge: true }) as Document,
    "/workspace/w.yaml",
    context,
  );
}

function at(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((holder, step) => (holder as Record<string, unknown>)[step], value);
}

/** What the loader does with a probe: the model it builds, or the message it refuses with. */
async function check(entry: SyntaxEntry): Promise<void> {
  if (entry.status === "refused") {
    await expect(parse(entry.probe), entry.id).rejects.toThrow(entry.message);
    return;
  }
  const spec = await parse(entry.probe);
  if (entry.observed !== undefined) {
    expect(at(spec, entry.observed.path), entry.id).toEqual(entry.observed.value);
  }
}

test("the syntax record matches what the loader does", async () => {
  const ids = syntax.entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...new Set<string>(syntax.entries.map((entry) => entry.status))].sort()).toEqual(
    Object.keys(syntax.statuses).sort(),
  );
  for (const entry of syntax.entries) {
    expect("message" in entry, entry.id).toBe(entry.status === "refused");
    expect("difference" in entry, entry.id).toBe(entry.status === "difference");
  }
  await Promise.all(syntax.entries.map(check));
});

test("the syntax record names every tmuxp key the catalog uses", async () => {
  const keys = new Set(syntax.entries.map((entry) => entry.key));
  const texts = await Promise.all(catalog.map((file) => readFile(join(fixtures, file), "utf8")));
  const used = new Set(
    texts.flatMap((text) =>
      [...text.matchAll(/^\s*(?:-\s+)?([a-z_]+):/gmu)].map((match) => match[1]!),
    ),
  );
  expect([...used].filter((key) => !keys.has(key) && key !== "cmd")).toEqual([]);
});

test("a changed loader fails the record", async () => {
  const refused = syntax.entries.find((entry) => entry.id === "config")!;
  const accepted = { ...refused, probe: ["session_name: a", "windows:", "  - panes: [{}]"] };
  await expect(check(accepted)).rejects.toThrow();
  const tilde = syntax.entries.find((entry) => entry.id === "start-directory-tilde")!;
  await expect(
    check({ ...tilde, observed: { path: ["directory"], value: "/workspace/~/x" } }),
  ).rejects.toThrow();
});
