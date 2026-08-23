import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { packageRoot } from "./package_root.js";

/**
 * Read the public surface of the handle classes out of their source.
 *
 * Read from the source rather than from a documentation generator: typedoc
 * carries its own TypeScript, and the version it bundles cannot parse this
 * one's. Everything the reference needs — the signature, the prose, the example
 * — is already in the file, and taking it from there keeps the reference and the
 * example check reading exactly the same thing.
 */

/** The handle classes a consumer actually holds. */
export const SOURCES = [
  "src/server.ts",
  "src/session.ts",
  "src/window.ts",
  "src/pane.ts",
  "src/client.ts",
  "src/selection.ts",
];

/**
 * Symbols that carry no example of their own, with the reason.
 *
 * Kept short and specific. A general exemption would let the rule decay into a
 * suggestion, which is the failure mode the example check exists to prevent.
 */
export const EXEMPT = new Set(["constructor", "equals", "toString"]);

/**
 * Interfaces that are API rather than an options bag.
 *
 * `Selection` is the type most of this library hands back, so its methods are
 * documented like a class's. An options bag is described as a whole instead —
 * asking for an example on each field documents nothing.
 */
const BEHAVIOURAL = new Set(["Selection"]);

export interface Member {
  /** The fenced example from the doc comment, without its fence. */
  readonly example: string | undefined;
  readonly file: string;
  readonly kind: "getter" | "method" | "property";
  readonly line: number;
  readonly name: string;
  /** The doc comment's prose, with the example and the comment leader removed. */
  readonly prose: string;
  /** The declaration as written, minus its body. */
  readonly signature: string;
}

export interface ApiClass {
  readonly file: string;
  readonly members: readonly Member[];
  readonly name: string;
  readonly prose: string;
}

function docAbove(
  lines: readonly string[],
  index: number,
): { end: number; start: number } | undefined {
  let end = index - 1;
  while (end >= 0 && (lines[end] ?? "").trim() === "") end -= 1;
  if (end < 0 || !(lines[end] ?? "").trimEnd().endsWith("*/")) return undefined;
  let start = end;
  while (start >= 0 && !(lines[start] ?? "").trim().startsWith("/**")) start -= 1;
  return start < 0 ? undefined : { end, start };
}

/** Split a doc comment into its prose and its example. */
function readDoc(block: readonly string[]): { example: string | undefined; prose: string } {
  const body = block.slice(1, -1).map((line) => line.replace(/^\s*\*\s?/u, "").trimEnd());
  const open = body.findIndex((line) => line.trim() === "```ts");
  if (open < 0) return { example: undefined, prose: body.join("\n").trim() };
  const close = body.findIndex((line, at) => at > open && line.trim() === "```");
  return {
    example: body.slice(open + 1, close < 0 ? undefined : close).join("\n"),
    prose: [...body.slice(0, open), ...(close < 0 ? [] : body.slice(close + 1))].join("\n").trim(),
  };
}

/** The declaration as written, gathered across lines and stripped of its body. */
function signatureAt(lines: readonly string[], index: number): string {
  const collected: string[] = [];
  for (let at = index; at < lines.length && at < index + 12; at += 1) {
    const line = lines[at] ?? "";
    collected.push(line.trim());
    if (/[{;]\s*$/u.test(line)) break;
  }
  return collected
    .join(" ")
    .replace(/\s*\{\s*$/u, "")
    .replace(/;$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

// A generic may contain a `>` — `batch<const T extends Planned<X>[]>` — so the
// parameter list ends at the `(` after it. The name alternation carries
// `[Symbol.iterator]`, which a plain-identifier group drops from the reference.
const MEMBER =
  /^ {2}(?:declare )?(?:static )?(?:readonly )?(?:async )?(?:(get|set) )?([a-zA-Z][a-zA-Z0-9_]*|\[[^\]]+\])(<[^(]*>)?\s*([(:])/u;

/** Every documented public member of every exported class in `source`. */
export function classesOf(source: string, file: string): readonly ApiClass[] {
  const lines = source.split("\n");
  const classes: { members: Member[]; name: string; prose: string }[] = [];
  let current: { members: Member[]; name: string; prose: string } | undefined;

  for (const [index, line] of lines.entries()) {
    const opened = /^export (?:abstract )?class (\w+)/u.exec(line);
    if (opened !== null) {
      const doc = docAbove(lines, index);
      current = {
        members: [],
        name: opened[1] ?? "",
        prose: doc === undefined ? "" : readDoc(lines.slice(doc.start, doc.end + 1)).prose,
      };
      classes.push(current);
      continue;
    }
    const declared = /^export interface (\w+)/u.exec(line);
    if (declared !== null) {
      // An interface can be either an options bag or a behavioural type. The
      // fields of a bag are described by the bag; the methods of a type like
      // `Selection` are the API, and are collected below.
      const doc = docAbove(lines, index);
      current = {
        members: [],
        name: declared[1] ?? "",
        prose: doc === undefined ? "" : readDoc(lines.slice(doc.start, doc.end + 1)).prose,
      };
      if (BEHAVIOURAL.has(current.name)) classes.push(current);
      else current = undefined;
      continue;
    }
    if (line.startsWith("export type ")) current = undefined;
    if (current === undefined) continue;

    const match = MEMBER.exec(line);
    if (match === null) continue;
    const name = match[2] ?? "";
    if (name === "" || match[1] === "set" || EXEMPT.has(name)) continue;
    if (/^ {2}(private|declare private)/u.test(line)) continue;
    const isCall = match[3] !== undefined || match[4] === "(";
    const isGetter = match[1] === "get";
    // A readonly field is surface a reader navigates — `pane.server` is how a
    // handle gets back to its server — so it is documented like a getter. A
    // writable field belongs to an options bag, which is described as a whole
    // rather than field by field. The prefixes match MEMBER's own: a predicate
    // narrower than the pattern feeding it is how a member goes quietly exempt.
    const isReadonlyField =
      !isCall && !isGetter && /^ {2}(?:declare )?(?:static )?readonly /u.test(line);
    if (!isCall && !isGetter && !isReadonlyField) continue;

    const doc = docAbove(lines, index);
    const read =
      doc === undefined
        ? { example: undefined, prose: "" }
        : readDoc(lines.slice(doc.start, doc.end + 1));
    current.members.push({
      example: read.example,
      file,
      kind: isGetter ? "getter" : isCall ? "method" : "property",
      line: index + 1,
      name,
      prose: read.prose,
      signature: signatureAt(lines, index),
    });
  }
  return classes.map((entry) => ({ ...entry, file }));
}

/** The whole documented surface, in the order a reader meets it. */
export async function readApiSurface(): Promise<readonly ApiClass[]> {
  const sources = await Promise.all(
    SOURCES.map(async (file) => ({
      file,
      source: await readFile(join(packageRoot, file), "utf8"),
    })),
  );
  return sources.flatMap(({ file, source }) => classesOf(source, file));
}
