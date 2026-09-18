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
  const heading = /^(?:export (?:async )?function (\w+)|  (?:async )?(\w+)(?:<[^>\n]*>)?)\(/gmu;
  for (const match of text.matchAll(heading)) {
    const name = match[1] ?? match[2]!;
    let cursor = match.index + match[0].length;
    for (let depth = 1; depth > 0 && cursor < text.length; cursor += 1) {
      if (text[cursor] === "(") depth += 1;
      else if (text[cursor] === ")") depth -= 1;
    }
    const parameters = text.slice(match.index + match[0].length, cursor - 1);
    const open = text.indexOf("{", cursor);
    if (open < 0) continue;
    let end = open + 1;
    for (let depth = 1; depth > 0 && end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
    }
    yield { body: text.slice(open, end), file, name, parameters };
  }
}

/** The whole bag went on, or its two deadline members were read out of it. */
const FORWARDS =
  /[(,]\s*options\s*[,)]|\.\.\.options\b|options\??\.(?:signal|timeoutMs)|\boptions,\s*$/mu;

const TAKES_OPTIONS = /\boptions\??\s*:\s*[A-Za-z]*Options\b/u;

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
   */
  test("hands the options bag to the command in every operation that takes one", async () => {
    const root = new URL("../../src/", import.meta.url).pathname;
    const checked: string[] = [];
    const dropped: string[] = [];

    const HANDLES = new Set(["client.ts", "pane.ts", "server.ts", "session.ts", "window.ts"]);
    for await (const relative of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
      if (!relative.startsWith("_internal/operations/") && !HANDLES.has(relative)) continue;
      const text = await Bun.file(`${root}${relative}`).text();
      for (const declaration of declarations(relative, text)) {
        if (!TAKES_OPTIONS.test(declaration.parameters)) continue;
        checked.push(`${declaration.file}:${declaration.name}`);
        if (!FORWARDS.test(declaration.body)) {
          dropped.push(`${declaration.file}:${declaration.name}`);
        }
      }
    }

    // A scan that matched nothing would report a clean tree.
    expect(checked.length).toBeGreaterThanOrEqual(60);
    expect(dropped).toEqual([]);
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
