import { join, relative } from "node:path";

import { createPlannedSymbol, fail } from "./manifest.js";
import type { ParityKind, PublicSymbol } from "./manifest.js";

const sourceUrl = "https://github.com/tmux-python/libtmux/blob/v0.62.0";
const modules = [
  "client",
  "common",
  "constants",
  "exc",
  "hooks",
  "neo",
  "options",
  "pane",
  "server",
  "session",
  "window",
] as const;
const testHelperModules = ["constants", "environment", "random", "retry", "temporary"] as const;
const ignoredMethods = new Set(["__init__"]);
const ignoredTestHelpers = new Set(["libtmux.pytest_plugin.USING_ZSH"]);
const compatibilityAliases = new Set([
  "Pane.get",
  "Pane.height",
  "Pane.id",
  "Pane.index",
  "Pane.resize_pane",
  "Pane.select_pane",
  "Pane.split_window",
  "Pane.title",
  "Pane.width",
  "Session.attach_session",
  "Session.attached_pane",
  "Session.attached_window",
  "Session.get",
  "Session.get_by_id",
  "Session.id",
  "Session.kill_session",
  "Session.name",
  "Session.find_where",
  "Session.list_windows",
  "Session.where",
  "Session.children",
  "Server.find_where",
  "Server.get_by_id",
  "Server.kill_server",
  "Server.list_sessions",
  "Server.where",
  "Server.children",
  "Window.attached_pane",
  "Window.find_where",
  "Window.get",
  "Window.get_by_id",
  "Window.height",
  "Window.id",
  "Window.index",
  "Window.kill_window",
  "Window.list_panes",
  "Window.name",
  "Window.select_window",
  "Window.set_window_option",
  "Window.show_window_option",
  "Window.show_window_options",
  "Window.split_window",
  "Window.where",
  "Window.width",
  "Window.children",
]);
const behaviorDunders = new Set([
  "__call__",
  "__eq__",
  "__enter__",
  "__exit__",
  "__getitem__",
  "__iter__",
  "__next__",
  "__repr__",
  "__str__",
]);
const enumMembers = {
  OptionScope: ["Server", "Session", "Window", "Pane"],
  PaneDirection: ["Above", "Below", "Right", "Left"],
  ResizeAdjustmentDirection: ["Up", "Down", "Left", "Right"],
  WindowDirection: ["Before", "After"],
} as const;
const rootExports = ["Client", "Pane", "Server", "Session", "Window"] as const;

export function runPythonGit(repository: string, arguments_: string[]): string {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd: repository,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) fail(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

class InventoryReader {
  private readonly repository: string;

  constructor(repository: string) {
    this.repository = repository;
  }

  derive(): PublicSymbol[] {
    const entries = [
      ...modules
        .flatMap((module) => this.collectModule(module))
        .filter((entry) => entry.kind !== "constant"),
      ...this.collectConstants(),
      ...this.collectFormatFields(),
      ...this.collectTestHelpers(),
      ...this.collectRootExports(),
      ...this.collectEnumMembers(),
    ];
    return entries.sort((left, right) =>
      `${left.kind}:${left.python}`.localeCompare(`${right.kind}:${right.python}`),
    );
  }

  private sourcePath(module: string, testHelper = false): string {
    return join(this.repository, "src/libtmux", testHelper ? "test" : "", `${module}.py`);
  }

  private readSource(path: string): string {
    const revisionPath = relative(this.repository, path);
    try {
      return runPythonGit(this.repository, ["show", `v0.62.0:${revisionPath}`]);
    } catch (error) {
      fail(`Unable to read v0.62.0:${revisionPath}: ${(error as Error).message}`);
    }
  }

  private createSymbol(kind: ParityKind, python: string, path: string): PublicSymbol {
    return createPlannedSymbol(kind, python, `${sourceUrl}/${relative(this.repository, path)}`);
  }

  private memberKind(className: string, memberName: string, property: boolean): ParityKind | null {
    const symbol = `${className}.${memberName}`;
    if (
      behaviorDunders.has(memberName) ||
      memberName.startsWith("_") ||
      ignoredMethods.has(memberName)
    ) {
      return null;
    }
    if (compatibilityAliases.has(symbol)) return "compatibility-alias";
    if (property) return "property";
    return "method";
  }

  private collectModule(module: string): PublicSymbol[] {
    const path = this.sourcePath(module);
    const lines = this.readSource(path).split("\n");
    const entries: PublicSymbol[] = [];
    const methods = new Set<string>();
    let currentClass: string | undefined;
    let property = false;

    for (const line of lines) {
      const classMatch = /^class ([A-Za-z][A-Za-z0-9_]*)/.exec(line);
      if (classMatch?.[1]) {
        currentClass = classMatch[1].startsWith("_") ? undefined : classMatch[1];
        property = false;
        if (currentClass) {
          entries.push(
            this.createSymbol(
              module === "exc" ? "exception" : "class",
              `libtmux.${module}.${currentClass}`,
              path,
            ),
          );
        }
        continue;
      }

      const topLevelDefinition = /^(?:def |[A-Z][A-Z0-9_]*(?::[^=]+)?\s*=)/.test(line);
      if (topLevelDefinition) {
        currentClass = undefined;
        property = false;
        const functionMatch = /^def ([a-z][A-Za-z0-9_]*)/.exec(line);
        if (functionMatch?.[1]) {
          entries.push(
            this.createSymbol("function", `libtmux.${module}.${functionMatch[1]}`, path),
          );
        }
        const constantMatch = /^([A-Z][A-Z0-9_]*)(?::[^=]+)?\s*=/.exec(line);
        if (constantMatch?.[1] && module !== "exc") {
          entries.push(
            this.createSymbol("constant", `libtmux.${module}.${constantMatch[1]}`, path),
          );
        }
        continue;
      }

      if (!currentClass) continue;
      if (line.trim() === "@property") {
        property = true;
        continue;
      }
      const methodMatch = /^    def ([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (!methodMatch?.[1] || module === "exc") continue;
      const key = `${currentClass}.${methodMatch[1]}`;
      if (methods.has(key)) {
        property = false;
        continue;
      }
      methods.add(key);
      const kind = this.memberKind(currentClass, methodMatch[1], property);
      if (kind) entries.push(this.createSymbol(kind, `libtmux.${module}.${key}`, path));
      property = false;
    }
    return entries;
  }

  private collectFormatFields(): PublicSymbol[] {
    const path = this.sourcePath("neo");
    const lines = this.readSource(path).split("\n");
    const entries: PublicSymbol[] = [];
    let inObj = false;
    for (const line of lines) {
      if (/^class Obj\b/.test(line)) inObj = true;
      else if (inObj && /^\S/.test(line)) break;
      if (!inObj) continue;
      const field = /^    ([a-z][a-z0-9_]+):/.exec(line)?.[1];
      if (field && field !== "server") {
        entries.push(this.createSymbol("format-field", `libtmux.neo.Obj.${field}`, path));
      }
    }
    return entries;
  }

  private collectTestHelpers(): PublicSymbol[] {
    const entries: PublicSymbol[] = [];
    for (const module of testHelperModules) {
      const path = this.sourcePath(module, true);
      const lines = this.readSource(path).split("\n");
      let currentClass: string | undefined;
      for (const line of lines) {
        const classMatch = /^class ([A-Za-z][A-Za-z0-9_]*)/.exec(line);
        if (classMatch?.[1]) {
          currentClass = classMatch[1];
          entries.push(
            this.createSymbol("test-helper", `libtmux.test.${module}.${currentClass}`, path),
          );
          continue;
        }
        const functionMatch = /^def ([a-z][A-Za-z0-9_]*)/.exec(line);
        if (functionMatch?.[1]) {
          currentClass = undefined;
          entries.push(
            this.createSymbol("test-helper", `libtmux.test.${module}.${functionMatch[1]}`, path),
          );
          continue;
        }
        const methodMatch = currentClass && /^    def ([a-z][A-Za-z0-9_]*)\(/.exec(line)?.[1];
        if (methodMatch && !behaviorDunders.has(methodMatch)) {
          entries.push(
            this.createSymbol(
              "test-helper",
              `libtmux.test.${module}.${currentClass}.${methodMatch}`,
              path,
            ),
          );
        }
        const constantMatch = /^([A-Z][A-Z0-9_]*)(?::[^=]+)?\s*=/.exec(line);
        if (constantMatch?.[1]) {
          entries.push(
            this.createSymbol("test-helper", `libtmux.test.${module}.${constantMatch[1]}`, path),
          );
        }
      }
    }

    const randomPath = this.sourcePath("random", true);
    entries.push(this.createSymbol("test-helper", "libtmux.test.random.namer", randomPath));

    const pluginPath = this.sourcePath("pytest_plugin");
    for (const line of this.readSource(pluginPath).split("\n")) {
      const functionMatch = /^def ([A-Za-z][A-Za-z0-9_]*)/.exec(line);
      if (functionMatch?.[1]) {
        entries.push(
          this.createSymbol("test-helper", `libtmux.pytest_plugin.${functionMatch[1]}`, pluginPath),
        );
      }
      const constantMatch = /^([A-Z][A-Z0-9_]*)(?::[^=]+)?\s*=/.exec(line);
      if (constantMatch?.[1]) {
        const python = `libtmux.pytest_plugin.${constantMatch[1]}`;
        if (!ignoredTestHelpers.has(python)) {
          entries.push(this.createSymbol("test-helper", python, pluginPath));
        }
      }
    }
    return entries;
  }

  private collectConstants(): PublicSymbol[] {
    const entries: PublicSymbol[] = [];
    for (const module of ["common", "constants", "formats", "neo", "options"]) {
      const path = this.sourcePath(module);
      for (const line of this.readSource(path).split("\n")) {
        const constant = /^([A-Z][A-Z0-9_]*)(?::[^=]+)?\s*=/.exec(line)?.[1];
        if (constant) {
          entries.push(this.createSymbol("constant", `libtmux.${module}.${constant}`, path));
        }
      }
    }
    const packagePath = join(this.repository, "src/libtmux/__init__.py");
    for (const name of [
      "__author__",
      "__copyright__",
      "__description__",
      "__email__",
      "__license__",
      "__package_name__",
      "__title__",
      "__version__",
    ]) {
      entries.push(this.createSymbol("constant", `libtmux.${name}`, packagePath));
    }
    return entries;
  }

  private collectRootExports(): PublicSymbol[] {
    const path = join(this.repository, "src/libtmux/__init__.py");
    const source = this.readSource(path);
    return rootExports.map((name) => {
      if (!source.includes(`from .${name.toLowerCase()} import ${name}`)) {
        fail(`missing audited root export ${name}`);
      }
      return this.createSymbol("root-export", `libtmux.${name}`, path);
    });
  }

  private collectEnumMembers(): PublicSymbol[] {
    const path = this.sourcePath("constants");
    const source = this.readSource(path);
    const entries: PublicSymbol[] = [];
    for (const [owner, members] of Object.entries(enumMembers)) {
      for (const member of members) {
        if (!new RegExp(`^    ${member} = `, "m").test(source)) {
          fail(`missing audited enum member ${owner}.${member}`);
        }
        entries.push(
          this.createSymbol("enum-member", `libtmux.constants.${owner}.${member}`, path),
        );
      }
    }
    return entries;
  }
}

export function derivePythonInventory(repository: string): PublicSymbol[] {
  return new InventoryReader(repository).derive();
}
