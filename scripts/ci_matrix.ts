/**
 * `.github/ci-matrix.txt`, the one place the tmux releases and Bun versions CI
 * runs are written down. The plan script, the documentation gates and the argv
 * budget test read it, and the typescript workflow reads the plan, so a list of
 * versions appears nowhere else.
 */

/** A tmux version, tag, branch or commit of github.com/tmux/tmux. */
export const TMUX_REF = /^[A-Za-z0-9._/-]{1,64}$/u;
const TOOLCHAIN = /^[A-Za-z0-9._-]{1,32}$/u;

/** `.github/ci-matrix.txt`, parsed. */
export interface CiMatrix {
  /** Bun versions the gates job runs. */
  readonly bun: readonly string[];
  /** Unreleased tmux. It runs with the whole table and may fail. */
  readonly development: readonly string[];
  /** The Bun version the tmux lanes run. */
  readonly laneBun: string;
  /** A branch that becomes a release, run with the whole table. */
  readonly preview: readonly string[];
  /** Releases below the floor, started to prove they are refused. */
  readonly refused: readonly string[];
  /** Released tmux, oldest first. The first and last are the edges. */
  readonly supported: readonly string[];
}

export class PlanError extends Error {}

export function fail(message: string): never {
  throw new PlanError(message);
}

export function validRef(value: string): boolean {
  return TMUX_REF.test(value) && !value.startsWith("-");
}

export function validToolchain(value: string): boolean {
  return TOOLCHAIN.test(value) && !value.startsWith("-");
}

/** Parse the manifest, refusing anything the plan could not trust. */
export function parseCiMatrix(text: string): CiMatrix {
  const lists: Record<"bun" | "development" | "preview" | "refused" | "supported", string[]> = {
    bun: [],
    development: [],
    preview: [],
    refused: [],
    supported: [],
  };
  const laneBun: string[] = [];
  const named = new Set<string>();

  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (line === "") continue;
    const fields = line.split(/\s+/u);
    const [kind, value] = fields;
    if (kind === undefined || value === undefined || fields.length !== 2) {
      fail(`malformed manifest line: ${line}`);
    }
    if (kind === "bun" || kind === "lane-bun") {
      if (!validToolchain(value)) fail(`manifest names an invalid Bun version: ${value}`);
      if (kind === "bun") {
        if (lists.bun.includes(value)) fail(`manifest repeats bun ${value}`);
        lists.bun.push(value);
      } else {
        laneBun.push(value);
      }
      continue;
    }
    if (
      kind !== "supported" &&
      kind !== "preview" &&
      kind !== "refused" &&
      kind !== "development"
    ) {
      fail(`manifest has an unknown kind: ${kind}`);
    }
    if (!validRef(value)) fail(`manifest names an invalid tmux ref: ${value}`);
    if (named.has(value)) fail(`manifest repeats tmux ${value}`);
    named.add(value);
    lists[kind].push(value);
  }

  if (lists.supported.length === 0) fail("manifest lists no supported tmux release");
  if (lists.bun.length === 0) fail("manifest lists no Bun version");
  if (laneBun.length !== 1) fail("manifest must name one Bun version for the tmux lanes");
  const [lane] = laneBun;
  if (lane === undefined || !lists.bun.includes(lane)) {
    fail(`the tmux lanes run Bun ${lane ?? "none"}, which the gates matrix does not`);
  }
  return { ...lists, laneBun: lane };
}
