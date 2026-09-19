import { describe, expect, test } from "bun:test";

import { Server } from "../../src/server.js";
import type { TmuxCommandResult, TmuxInvocationRequest } from "../../src/engine.js";
import { flattenInvocation } from "../../src/engine.js";
import { singleCommandTransport } from "../support/transport_double.js";

function success(request: TmuxInvocationRequest): TmuxCommandResult {
  return {
    cmd: [request.executable, ...flattenInvocation(request)],
    exitCode: 0,
    signal: null,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
  };
}

/** Everything reached by a balanced-brace walk from one declaration. */
interface Declaration {
  readonly body: string;
  readonly file: string;
  readonly name: string;
  readonly parameters: string;
}

function* declarations(file: string, text: string): Generator<Declaration> {
  // The name, then its parameters, then its body. Everything between them is
  // walked rather than matched: a pattern that stops at the first `>` skips
  // `batch<const T extends readonly PlannedOperation<unknown>[]>` entirely,
  // and `indexOf("{")` after the parameters can land in a return type like
  // `Promise<{ -readonly [K in keyof T]: … }>` rather than in the body. A
  // heading that requires `export` also hides a non-exported method like
  // `runPlan`.
  const heading = /^(?:(?:export )?(?:async )?function (\w+)|  (?:async )?(\w+))(?=[<(])/gmu;
  for (const match of text.matchAll(heading)) {
    const name = match[1] ?? match[2]!;
    let cursor = skipBalanced(text, match.index + match[0].length, "<", ">");
    if (text[cursor] !== "(") continue;
    const parametersFrom = cursor + 1;
    cursor = skipBalanced(text, cursor, "(", ")");
    const parameters = text.slice(parametersFrom, cursor - 1);

    // The first brace that opens a block rather than a type: one at angle depth
    // zero whose closing brace is not itself followed by another brace.
    let open = cursor;
    for (let angles = 0; open < text.length; open += 1) {
      if (text[open] === "=" && text[open + 1] === ">") open += 1;
      else if (text[open] === "<") angles += 1;
      else if (text[open] === ">") angles -= 1;
      else if (text[open] === "{" && angles <= 0) {
        const close = skipBalanced(text, open, "{", "}");
        if (text.slice(close).trimStart().startsWith("{")) open = close - 1;
        else break;
      }
    }
    if (open >= text.length) continue;
    yield { body: text.slice(open, skipBalanced(text, open, "{", "}")), file, name, parameters };
  }
}

/** The index just past the `open` at `from` and everything it encloses. */
function skipBalanced(text: string, from: number, open: string, close: string): number {
  if (text[from] !== open) return from;
  let cursor = from + 1;
  for (let depth = 1; depth > 0 && cursor < text.length; cursor += 1) {
    if (text[cursor] === open) depth += 1;
    else if (text[cursor] === close) depth -= 1;
  }
  return cursor;
}

/**
 * The whole bag went on, or its two deadline members were read out of it, or
 * `timeoutMs` alone was taken out to be resolved — a `null` there means "no
 * deadline" and must not reach a timer — and the rest spread on after it.
 * Taking `signal` out that way is not accepted, since nothing then shows it
 * went anywhere.
 */
const FORWARDS =
  /[(,]\s*options\s*[,)]|\.\.\.options\b|options\??\.(?:signal|timeoutMs)|\boptions,\s*$|\{\s*timeoutMs\s*,\s*\.\.\.(\w+)\s*\}\s*=\s*options\b[\s\S]*?\.\.\.\1\b/mu;

const TAKES_OPTIONS = /\boptions\??\s*:\s*[A-Za-z]*Options\b/u;

/**
 * A declaration with somewhere to forward to: it awaits something, or returns
 * a call's result. This excludes eight — five argv builders like
 * `newWindowArgs`, the two `window.ts` helpers that rewrite a destination and
 * hand the bag back, and `Server`'s constructor. None has a call under it that
 * could carry a deadline, and requiring a forward would only teach the gate to
 * lie.
 */
const RUNS = /\bawait\b|\breturn\s+[A-Za-z_$][\w$.]*\(/u;

/**
 * Reads of the whole server inside `body` whose arguments never mention a
 * signal. `FORWARDS` asks only whether the bag appears somewhere, so a body
 * that forwards to its command and then reads the server unsignalled satisfies
 * it — which is what `batch` did.
 */
function unsignalledReads(body: string): string[] {
  const reads = /\b(?:this\.snapshot|server\.snapshot|buildServerSnapshot)\(/gu;
  const found: string[] = [];
  for (const match of body.matchAll(reads)) {
    const open = match.index + match[0].length - 1;
    const args = body.slice(open + 1, skipBalanced(body, open, "(", ")") - 1);
    if (!/\bsignal\b|^\s*options\b/u.test(args)) found.push(`${match[0]}${args.trim()})`);
  }
  return found;
}

describe("command option forwarding", () => {
  /**
   * `CommandOptions` carries `signal` and `timeoutMs`, and a method that
   * accepts them and drops them type-checks perfectly while doing nothing:
   * `runShell` read `options.target` and forwarded none of the rest, so a
   * per-call deadline shorter than the server's never bounded the call. That
   * is invisible to every other gate here, because the wrong behaviour is the
   * absence of an argument.
   *
   * This reads the source rather than calling each method, which no unit test
   * can do without a live server for most of them. It proves the argument is
   * passed on, not that the transport honoured it — the case below proves
   * that end of it for the paths a fake engine can reach.
   *
   * Forwarding once is not forwarding: `batch` handed the bag to its commands
   * and then read the server unsignalled, which satisfies a check that asks
   * only whether the bag appears. Each read is examined on its own.
   */
  test("hands the options bag to the command in every operation that takes one", async () => {
    const root = new URL("../../src/", import.meta.url).pathname;
    const checked: string[] = [];
    const dropped: string[] = [];
    const unsignalled: string[] = [];

    const HANDLES = new Set(["client.ts", "pane.ts", "server.ts", "session.ts", "window.ts"]);
    for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
      if (!relative.startsWith("_internal/operations/") && !HANDLES.has(relative)) continue;
      const text = await Bun.file(`${root}${relative}`).text();
      for (const declaration of declarations(relative, text)) {
        if (!TAKES_OPTIONS.test(declaration.parameters) || !RUNS.test(declaration.body)) continue;
        checked.push(`${declaration.file}:${declaration.name}`);
        if (!FORWARDS.test(declaration.body)) {
          dropped.push(`${declaration.file}:${declaration.name}`);
        }
        for (const read of unsignalledReads(declaration.body)) {
          unsignalled.push(`${declaration.file}:${declaration.name} ${read}`);
        }
      }
    }

    // A scan that matched nothing would report a clean tree, and so would one
    // that matched all but the declaration at issue: both read as a clean
    // tree while carrying a dropped option.
    expect(checked.length).toBeGreaterThanOrEqual(60);
    expect(checked).toContain("server.ts:batch");
    expect(checked).toContain("_internal/operations/mutations.ts:runPlan");
    expect(dropped).toEqual([]);
    expect(unsignalled).toEqual([]);
  });

  test("carries a per-call deadline through to the invocation", async () => {
    const requests: TmuxInvocationRequest[] = [];
    const engine = singleCommandTransport((request) => {
      requests.push(request);
      return Promise.resolve(success(request));
    });
    const server = new Server({ engine, timeoutMs: 5_000 });

    await server.runShell("true", { timeoutMs: 11 });
    await server.setOption("status", "off", { timeoutMs: 12 });
    await server.setHook("after-new-window", "display-message hi", { timeoutMs: 13 });
    await server.setEnvironment("EDITOR", "vim", { timeoutMs: 14 });
    await server.ifShell("true", "display-message hi", { timeoutMs: 15 });
    await server.saveBuffer("scratch", "/tmp/ltx-nowhere", { timeoutMs: 16 });

    expect(requests.map((request) => request.timeoutMs)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  /**
   * A command is bounded unless told otherwise. `null` lifts the bound on the
   * server or on one call; a command that waits on a person gets none by
   * default, since a deadline would cut them off, though one passed on the
   * call still binds it. `wait` is tmux's own short name for `wait-for`.
   */
  test("bounds a command by default, and lifts it for null and for a person", async () => {
    const requests: TmuxInvocationRequest[] = [];
    const engine = singleCommandTransport((request) => {
      requests.push(request);
      return Promise.resolve(success(request));
    });
    const server = new Server({ engine });

    await server.cmd("list-sessions");
    await server.cmd("list-sessions", [], { timeoutMs: null });
    await server.cmd("wait-for", ["ltx-channel"]);
    await server.cmd("wait", ["ltx-channel"]);
    await server.cmd("display-popup", [], { timeoutMs: 9 });
    await new Server({ engine, timeoutMs: null }).cmd("list-sessions");
    await new Server({ engine, timeoutMs: 7 }).cmd("list-sessions");

    expect(requests.map((request) => request.timeoutMs)).toEqual([
      30_000,
      undefined,
      undefined,
      undefined,
      9,
      undefined,
      7,
    ]);
  });

  test("lets a per-call signal cancel one command without the server's", async () => {
    const controller = new AbortController();
    const engine = singleCommandTransport(
      (request) =>
        new Promise((resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          if (request.signal === undefined) resolve(success(request));
        }),
    );
    const server = new Server({ engine });

    const pending = server.runShell("sleep 10", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
