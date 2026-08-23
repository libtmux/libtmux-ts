import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { packageRoot } from "../package_root.js";
import { join } from "node:path";

/**
 * Compile documentation examples against the package's own API.
 *
 * Shared by the README check and the doc-comment check because a snippet that
 * does not compile is worse than no snippet wherever it appears: it is a
 * documented lie about the signature. Both need the same bargain — a reader is
 * assumed to already hold a `server` and a `session`, and their `"libtmux"` is
 * this working tree rather than a published release.
 */

const typeScriptExecutable = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));

/**
 * Names an example may use without introducing them.
 *
 * One list, two readers: the typecheck path declares them so a fragment
 * compiles, and the execution path binds them so the same fragment runs. A name
 * that exists for only one of those is a fragment that compiles and cannot run.
 */
export const BINDINGS: readonly string[] = Object.freeze([
  "server",
  "session",
  "window",
  "editor",
  "pane",
  "client",
  "snapshot",
  "selection",
  "live",
  "other",
  "otherPane",
  "command",
  "marker",
]);

/**
 * Whether a block introduces `name` itself.
 *
 * A self-contained example declares its own `server`. TypeScript lets that
 * shadow an ambient declaration; a runtime binding in the same scope is a
 * redeclaration, so the execution path has to leave those alone.
 */
export function declaresOwn(body: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|using|function|class)\\s+${name}\\b`, "u").test(body);
}

/** The bindings a block refers to and does not introduce itself. */
export function bindingsFor(body: string): readonly string[] {
  return BINDINGS.filter(
    (name) => new RegExp(`\\b${name}\\b`, "u").test(body) && !declaresOwn(body, name),
  );
}

/** Names an example may use without introducing them, and what they are. */
export const PREAMBLE = `
import { Server, Session } from "../../src/index.js";
import type {
  Client as ClientHandle,
  ConnectedServer as ConnectedServerHandle,
  Pane as PaneHandle,
  Selection as SelectionOf,
  Server as ServerHandle,
  ServerSnapshot as SnapshotOf,
  Session as SessionHandle,
  Window as WindowHandle,
} from "../../src/index.js";

declare const server: ServerHandle;
declare const session: SessionHandle;
declare const window: WindowHandle;
declare const editor: WindowHandle;
declare const pane: PaneHandle;
declare const client: ClientHandle;
declare const snapshot: SnapshotOf;
declare const selection: SelectionOf<SessionHandle>;
declare const live: ConnectedServerHandle;
declare const other: WindowHandle;
declare const otherPane: PaneHandle;
// The parameters the runnable examples take. A recipe marked
// \`<!-- runs: examples/x.ts -->\` has to match that file line for line, so it
// cannot invent literals where the example named an argument.
declare const command: string;
declare const marker: string;
`;

/**
 * How a block is covered, when it is not run here.
 *
 * Two markers, both already the repository's: `<!-- runs: examples/x.ts -->`
 * ties the block to a file the integration suite executes, and every line the
 * block shows must appear there; `<!-- static: why -->` says the block's effect
 * cannot be observed at all. Running a block proves it does not throw, which is
 * worth having and is all it proves, so a block that cannot be run says which
 * of the two it is rather than sitting silently uncovered.
 */
export type Coverage =
  | { readonly kind: "runs"; readonly source: string }
  | { readonly kind: "static"; readonly reason: string };

export interface Example {
  readonly code: string;
  readonly coverage?: Coverage;
  /** Where a reader would go to edit it, as `file:line`. */
  readonly origin: string;
}

export function fencedBlocks(text: string, origin: (line: number) => string): readonly Example[] {
  const blocks: Example[] = [];
  const lines = text.split("\n");
  let open: { code: string[]; coverage?: Coverage; line: number } | undefined;
  let pending: Coverage | undefined;
  for (const [index, line] of lines.entries()) {
    if (open === undefined) {
      const marked = /^<!--\s*(?<kind>runs|static):\s*(?<value>.+?)\s*-->$/u.exec(line.trim());
      if (marked !== null) {
        const value = marked.groups?.["value"] ?? "";
        pending =
          marked.groups?.["kind"] === "runs"
            ? { kind: "runs", source: value }
            : { kind: "static", reason: value };
        continue;
      }
      if (line.trim() === "```ts") {
        open = {
          code: [],
          line: index + 2,
          ...(pending === undefined ? {} : { coverage: pending }),
        };
        pending = undefined;
        continue;
      }
      // A marker binds to the fence below it, so anything else in between is a
      // marker on nothing — which would silently excuse a block it never named.
      if (pending !== undefined && line.trim() !== "") {
        throw new Error(`a coverage marker at line ${String(index)} is not above a \`\`\`ts block`);
      }
      continue;
    }
    if (line.trim() === "```") {
      blocks.push({
        code: open.code.join("\n"),
        origin: origin(open.line),
        ...(open.coverage === undefined ? {} : { coverage: open.coverage }),
      });
      open = undefined;
      continue;
    }
    open.code.push(line);
  }
  if (open !== undefined) throw new Error("an example block was never closed");
  return blocks;
}

/**
 * An example's own imports have to reach the top of the generated module, and a
 * reader's `"libtmux"` is this repository's source.
 */
/** Names the preamble already brings in, which a block may not import again. */
const PROVIDED = new Set(["Server", "Session"]);

/**
 * Separate a block's imports from its body, dropping the ones already in scope.
 *
 * `taken` carries the names emitted so far, across every block: the generated
 * module holds one copy of each import above bodies that are separate
 * functions, so two blocks showing a reader the same import would otherwise
 * collide as a duplicate identifier — a complaint about the harness rather
 * than about either example.
 */
function split(
  code: string,
  taken: Map<string, string>,
): { readonly body: string; readonly imports: string } {
  const imports: string[] = [];
  const body: string[] = [];
  for (const line of code.split("\n")) {
    if (/^import\s/u.test(line)) {
      // Resolved to source, not to `dist`. A README block imports the package
      // the way a reader does, and compiling that against the built output
      // would make this gate depend on a build having run first — which is how
      // `libtmux/engine` typechecked here and failed in CI, where the check
      // runs before the build.
      const rewritten = line
        .replace(/"libtmux"/u, '"../../src/index.js"')
        .replace(/"libtmux\/([\w-]+)"/u, '"../../src/$1.js"');
      // One line per import. A wrapped one leaves its specifiers in the body,
      // and the errors that produces name the prose around the block rather
      // than the import that caused them.
      if (rewritten.includes("{") && !rewritten.includes("}")) {
        throw new Error(`an example import must fit on one line: ${line}`);
      }
      const named = /^import \{([^}]*)\} from (.*)$/u.exec(rewritten);
      if (named === null) {
        imports.push(rewritten);
        continue;
      }
      const from = named[2] ?? "";
      const kept = (named[1] ?? "")
        .split(",")
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier !== "" && !PROVIDED.has(specifier))
        // Kept when the same name arrives from somewhere else, so the
        // collision is reported rather than resolved to whichever came first.
        .filter((specifier) => taken.get(specifier) !== from);
      for (const specifier of kept) taken.set(specifier, from);
      if (kept.length > 0) imports.push(`import { ${kept.join(", ")} } from ${from}`);
      continue;
    }
    body.push(line);
  }
  return { body: body.join("\n"), imports: imports.join("\n") };
}

/**
 * Typecheck every example, reporting failures against the file a reader edits.
 *
 * Each becomes the body of its own function, so a `const` in one cannot satisfy
 * a reference in another and every example has to stand up alone the way a
 * reader meets it.
 */
export async function typecheckExamples(
  examples: readonly Example[],
  label: string,
): Promise<void> {
  const imports: string[] = [];
  const bodies: string[] = [];
  const taken = new Map<string, string>();
  for (const [index, example] of examples.entries()) {
    const { body, imports: exampleImports } = split(example.code, taken);
    if (exampleImports !== "") imports.push(exampleImports);
    bodies.push(
      `// ${example.origin}\nexport async function example${String(index)}(): Promise<void> {\n${body}\n}\n`,
    );
  }

  const generated = `${PREAMBLE}\n${imports.join("\n")}\n\n${bodies.join("\n")}`;
  // Generated inside the repository so `../../src` resolves and the examples
  // are judged against this working tree rather than a published release.
  const directory = join(packageRoot, "node_modules", `.examples-${label}`);
  await mkdir(directory, { recursive: true });
  const modulePath = join(directory, "examples.ts");
  try {
    await writeFile(modulePath, generated);
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          // A reader's project is not this one, so an example is judged under
          // the settings the docs tell them to use rather than the
          // repository's, with the globals their runtime provides in scope.
          lib: ["ESNext", "ESNext.Disposable", "DOM"],
          module: "esnext",
          moduleResolution: "bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "esnext",
          types: ["bun"],
        },
        files: [modulePath],
      }),
    );

    const result = Bun.spawnSync(
      [typeScriptExecutable, "-p", join(directory, "tsconfig.json"), "--pretty", "false"],
      { cwd: packageRoot, stderr: "pipe", stdout: "pipe" },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    if (result.exitCode !== 0 || output !== "") {
      // Map a generated line back to the line a reader would edit.
      const mapped = output.replaceAll(
        /examples\.ts\((\d+),(\d+)\)/gu,
        (whole, rawLine: string) => {
          const target = Number.parseInt(rawLine, 10);
          const preceding = generated
            .split("\n")
            .slice(0, target)
            .reverse()
            .find((line) => line.startsWith("// ") && line.includes(":"));
          return preceding === undefined ? whole : `${preceding.slice(3)} (via ${whole})`;
        },
      );
      process.stderr.write(`${label} examples do not typecheck:\n${mapped}\n`);
      process.exit(1);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
