import { describe, expect, test } from "bun:test";

import * as errors from "../../src/errors.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

type ErrorClass = new (...args: never[]) => Error;

/**
 * Every error class the module exports, by the name it is exported under.
 *
 * Read from the module rather than listed here, so a class added without a
 * `code` of its own fails this suite instead of quietly inheriting its
 * parent's.
 */
const ERROR_CLASSES: readonly (readonly [string, ErrorClass])[] = Object.entries(errors)
  .filter(
    (entry): entry is [string, ErrorClass] =>
      typeof entry[1] === "function" &&
      (entry[1] === errors.LibTmuxError || entry[1].prototype instanceof errors.LibTmuxError),
  )
  // A deprecated alias is the same constructor exported under its old name.
  // Discriminating on the constructor's own identifier keeps this list
  // independent of `code`, which is what these cases are about.
  .filter(([name, value]) => value.name === name);

/**
 * Arguments that satisfy each constructor. JSON so the bundled fixture builds
 * the same instances from the same list rather than from a second copy of it.
 */
const ARGUMENTS: Readonly<Record<string, readonly unknown[]>> = Object.freeze({
  QueryValidationError: [{ message: "m", reason: "invalid-query" }],
  TmuxCommandError: [{ args: ["list-sessions"], exitCode: 1, stderr: [] }],
  TmuxTransportError: ["m", { delivery: "not_started", kind: "timeout" }],
});

const argumentsFor = (name: string): readonly unknown[] => ARGUMENTS[name] ?? ["m"];

const construct = (Class: ErrorClass, name: string): Error =>
  new Class(...(argumentsFor(name) as never[]));

describe("error identity", () => {
  test("covers every exported error class", () => {
    // A filter that silently matched nothing would make every case below pass.
    expect(ERROR_CLASSES.length).toBeGreaterThanOrEqual(12);
    expect(ERROR_CLASSES.map(([name]) => name)).toContain("LibTmuxError");
  });

  test("declares its own code rather than inheriting one", () => {
    for (const [name, Class] of ERROR_CLASSES) {
      expect(Object.hasOwn(Class, "code"), `${name} declares its own code`).toBe(true);
    }
  });

  test("gives each class a distinct code", () => {
    const codes = ERROR_CLASSES.map(([, Class]) => (Class as { readonly code: string }).code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("writes that code to both name and code on an instance", () => {
    for (const [name, Class] of ERROR_CLASSES) {
      const error = construct(Class, name);
      expect(error.name, `${name}.name`).toBe(name);
      expect((error as unknown as { readonly code: string }).code, `${name}.code`).toBe(name);
    }
  });

  /**
   * The module enumeration above only sees `src/errors.ts`. A class declared
   * anywhere else inherits its parent's identifier silently, which is how
   * `FormatProtocolError` came to report `LibTmuxError` — so the rule is
   * checked against the source rather than against one module's exports.
   */
  test("declares a code on every error class in the package, not only the exported ones", async () => {
    const root = new URL("../../src/", import.meta.url).pathname;
    const files = new Bun.Glob("**/*.ts").scan({ cwd: root });
    const known = new Set(["LibTmuxError", ...ERROR_CLASSES.map(([name]) => name)]);
    const declarations: string[] = [];

    for await (const relative of files) {
      const text = await Bun.file(`${root}${relative}`).text();
      for (const match of text.matchAll(
        /(?:export )?class (?<name>\w+) extends (?<parent>\w+) \{(?<body>[^}]*)/gu,
      )) {
        const { name, parent, body } = match.groups!;
        if (!known.has(parent!)) continue;
        known.add(name!);
        declarations.push(`${relative}:${name!}`);
        expect(body, `${relative} declares a code on ${name!}`).toContain(
          `static override readonly code: string = ${JSON.stringify(name!)}`,
        );
      }
    }
    // The scan finding nothing would make the assertion above vacuous.
    expect(declarations.length).toBeGreaterThanOrEqual(12);
  });

  test("keeps a deprecated alias reporting the canonical name", () => {
    expect(new errors.WaitTimeout("x").name).toBe("WaitTimeoutError");
    expect(new errors.LibTmuxException("x").code).toBe("LibTmuxError");
  });

  /**
   * The reason the identifier is a declared literal rather than
   * `new.target.name`: a constructor's `name` is its identifier, and a
   * consumer bundling with identifier minification renames it. Before this,
   * nine of the classes here reported names like `"m"` in a `--minify` build,
   * while the two that hard-coded a string survived — so the property under
   * test is exactly the one a consumer's build decides.
   */
  test("survives a consumer bundling with identifier minification", async () => {
    const directory = await makeTestDirectory("ltx-minify-");
    const entry = `${directory}/entry.ts`;
    const bundle = `${directory}/bundle.js`;
    const source = new URL("../../src/errors.ts", import.meta.url).pathname;
    // Constructed instances, not the static declaration: a bundler leaves a
    // string literal alone wherever it sits, so reading the declaration back
    // would pass even where the constructor derives its identifier from
    // `new.target.name`. What a consumer reads is `error.name`.
    const cases = ERROR_CLASSES.map(([name]) => [name, argumentsFor(name)]);
    await Bun.write(
      entry,
      `import * as errors from ${JSON.stringify(source)};\n` +
        `const out = {};\n` +
        `for (const [name, args] of ${JSON.stringify(cases)}) {\n` +
        `  const error = new errors[name](...args);\n` +
        `  out[name] = [error.name, error.code];\n` +
        `}\n` +
        `console.log(JSON.stringify(out));\n`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      minify: true,
      target: "bun",
      outdir: directory,
      naming: "bundle.js",
    });
    expect(built.success).toBe(true);

    const run = Bun.spawnSync({ cmd: [process.execPath, bundle] });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const reported: Record<string, [string, string]> = JSON.parse(run.stdout.toString());

    for (const [name] of ERROR_CLASSES) {
      expect(reported[name], `${name} after --minify`).toEqual([name, name]);
    }
  }, 30_000);
});
