import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

export const tsRoot = fileURLToPath(new URL("..", import.meta.url));
const typeScriptExecutable = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));

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

export interface Example {
  readonly code: string;
  /** Where a reader would go to edit it, as `file:line`. */
  readonly origin: string;
}

/** Collect the ```ts blocks out of a markdown-ish body. */
export function fencedBlocks(text: string, origin: (line: number) => string): readonly Example[] {
  const blocks: Example[] = [];
  const lines = text.split("\n");
  let open: { code: string[]; line: number } | undefined;
  for (const [index, line] of lines.entries()) {
    if (open === undefined) {
      if (line.trim() === "```ts") open = { code: [], line: index + 2 };
      continue;
    }
    if (line.trim() === "```") {
      blocks.push({ code: open.code.join("\n"), origin: origin(open.line) });
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

function split(code: string): { readonly body: string; readonly imports: string } {
  const imports: string[] = [];
  const body: string[] = [];
  for (const line of code.split("\n")) {
    if (/^import\s/u.test(line)) {
      const rewritten = line.replace(/"libtmux"/u, '"../../src/index.js"');
      // A README block shows the import a reader would write, and the preamble
      // has already introduced some of those names for the examples that do not
      // show one. Keeping both is a duplicate identifier rather than a problem
      // with either, so the block's redundant specifiers come off here.
      const named = /^import \{([^}]*)\} from (.*)$/u.exec(rewritten);
      if (named === null) {
        imports.push(rewritten);
        continue;
      }
      const kept = (named[1] ?? "")
        .split(",")
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier !== "" && !PROVIDED.has(specifier));
      if (kept.length > 0) imports.push(`import { ${kept.join(", ")} } from ${named[2] ?? ""}`);
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
  for (const [index, example] of examples.entries()) {
    const { body, imports: exampleImports } = split(example.code);
    if (exampleImports !== "") imports.push(exampleImports);
    bodies.push(
      `// ${example.origin}\nexport async function example${String(index)}(): Promise<void> {\n${body}\n}\n`,
    );
  }

  const generated = `${PREAMBLE}\n${imports.join("\n")}\n\n${bodies.join("\n")}`;
  // Generated inside the repository so `../../src` resolves and the examples
  // are judged against this working tree rather than a published release.
  const directory = join(tsRoot, "node_modules", `.examples-${label}`);
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
      { cwd: tsRoot, stderr: "pipe", stdout: "pipe" },
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
