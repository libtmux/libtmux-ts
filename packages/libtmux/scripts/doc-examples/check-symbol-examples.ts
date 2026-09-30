import { fencedBlocks, typecheckExamples, type Example } from "./example_harness.js";
import {
  readApiSurface,
  readRootApiSurface,
  requireRootExamples,
  requireSymbolExamples,
} from "../api_surface.js";

/**
 * Require a working example on every public method and getter, and compile it.
 *
 * A signature tells a reader what a call accepts; it does not tell them what to
 * pass, what comes back, or why the method exists. The gap is largest exactly
 * where the API is least guessable, so the rule is per symbol rather than per
 * file: a class with thirty methods and two examples documents two methods.
 *
 * The surface is read by the same parser that writes the reference, so a member
 * cannot be missing from one and present in the other — a member the parser
 * fails to see is silently exempt, which is the quietest way for this check to
 * stop meaning anything.
 */

const surface = await readApiSurface();
const members = requireSymbolExamples(
  surface.flatMap((entry) => entry.members.map((member) => ({ ...member, owner: entry.name }))),
);

const examples: Example[] = members.map((member): Example => ({
  code: member.example,
  origin: `${member.file}:${String(member.line)}`,
}));
const root = requireRootExamples(await readRootApiSurface());
examples.push(
  ...root.map((entry) => ({
    code: entry.example,
    origin: `${entry.file}:${String(entry.line)}`,
  })),
);

// Class-level and interface-level examples are compiled too, so a type's own
// documentation cannot drift from its members'.
for (const entry of surface) {
  examples.push(...fencedBlocks(entry.prose, (line) => `${entry.file}:${String(line)}`));
}

await typecheckExamples(examples, "symbol");

// Separate modules have no preamble: another example cannot supply an import.
const standaloneNames = new Set([
  "Server.sessions",
  "Server.windows",
  "Server.panes",
  "Server.newSession",
  "Pane.capture",
]);
const standalone = members
  .filter((member) => standaloneNames.has(`${member.owner}.${member.name}`))
  .map((member): Example => ({
    code: member.example,
    origin: `${member.file}:${String(member.line)}`,
  }));
const server = surface.find((entry) => entry.name === "Server");
if (server !== undefined)
  standalone.push(...fencedBlocks(server.prose, (line) => `${server.file}:${String(line)}`));
if (standalone.length !== standaloneNames.size + 1)
  throw new Error("Missing complete API examples");
await typecheckExamples(standalone, "standalone-symbol", true);

process.stdout.write(
  `symbol examples: ${String(members.length)} public members, ${String(
    root.length,
  )} root declarations, ${String(examples.length)} compiled examples\n`,
);
