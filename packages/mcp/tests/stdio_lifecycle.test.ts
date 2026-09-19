import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  deadlineMs,
  makeTestDirectory,
  readProcessIdentity,
  resolveNode22,
  runWithCleanup,
  type TestServer,
} from "../../libtmux/src/_internal/test/testkit.js";
import { structured, withServer } from "./support/server_harness.js";

type Runtime = "bun" | "node";

async function withProgram(
  fixture: TestServer,
  runtime: Runtime,
  body: (program: {
    readonly client: Client;
    readonly endInput: () => void;
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    readonly stderr: () => string;
  }) => Promise<void>,
  script?: string,
): Promise<void> {
  const executable = runtime === "bun" ? process.execPath : await resolveNode22();
  const entry = new URL(
    runtime === "bun" ? "../src/server.ts" : "../dist/server.js",
    import.meta.url,
  );
  const home = await makeTestDirectory("ltx-mcp-eof-");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...fixture.controllerEnvironment,
    HOME: home,
    LIBTMUX_SOCKET_PATH: fixture.socketPath,
    LIBTMUX_TMUX_BIN: fixture.tmuxExecutable,
    LIBTMUX_TOOLSETS: "inspect",
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
  };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  const child = spawn(
    executable,
    script === undefined
      ? [fileURLToPath(entry)]
      : [
          ...(runtime === "node" ? ["--input-type=module"] : []),
          "--eval",
          `const entry = ${JSON.stringify(entry.href)};\n${script}`,
        ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env: environment, stdio: "pipe" },
  );
  let diagnostic = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    diagnostic += chunk;
  });
  const client = new Client({ name: "stdio-lifecycle", version: "0.0.0" });
  // The SDK supplies framing; this fixture owns process exit and stdin EOF.
  const transport = new StdioServerTransport(child.stdout, child.stdin);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        transport.onclose?.();
        resolve({ code, signal });
      });
    },
  );
  await runWithCleanup(
    () =>
      runWithCleanup(
        async () => {
          if (script === undefined) await client.connect(transport);
          await body({
            client,
            endInput: () => child.stdin.end(),
            exited,
            stderr: () => diagnostic,
          });
        },
        async () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await exited;
          await client.close();
        },
      ),
    () => rm(home, { force: true, recursive: true }),
  );
}

async function boundedExit(
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timed out"> {
  const abort = new AbortController();
  try {
    return await Promise.race([
      exited,
      delay(deadlineMs(1_000), "timed out" as const, { signal: abort.signal }),
    ]);
  } finally {
    abort.abort();
  }
}

for (const runtime of ["bun", "node"] as const) {
  test.each(["active", "completed"] as const)(
    `${runtime} stdin EOF closes the %s live wait and preserves the keeper`,
    async (state) => {
      await withServer(async (fixture) => {
        const keeper = async (): Promise<string> =>
          (
            await fixture.executeText([
              "display-message",
              "-p",
              "-t",
              "mcp",
              "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}",
            ])
          ).stdout.join("\n");
        const clients = async (): Promise<string> =>
          (await fixture.executeText(["list-clients", "-F", "#{client_pid}"])).stdout.join("\n");
        const before = await keeper();
        expect(before.trim()).toMatch(/^\d+\t\$\d+\t@\d+\t%\d+$/u);
        expect((await clients()).trim()).toBe("");
        await withProgram(fixture, runtime, async ({ client, endInput, exited, stderr }) => {
          const panes = structured<{ panes: readonly { id: string }[] }>(
            await client.callTool({ name: "list_panes", arguments: { session: "mcp" } }),
          ).panes;
          expect(panes).toHaveLength(1);
          const paneId = panes[0]?.id;
          expect(paneId).toMatch(/^%\d+$/u);
          const seeded = structured<{ cursor: string }>(
            await client.callTool({ name: "capture_since", arguments: { paneId } }),
          );
          expect(seeded.cursor).toBeString();
          const controlPids = (await clients()).trim().split("\n").map(Number);
          expect(controlPids).toHaveLength(1);
          const identities = await Promise.all(controlPids.map(readProcessIdentity));
          expect(identities.every((identity) => identity !== undefined)).toBe(true);
          const waiting = client
            .callTool({
              name: "wait_for_text",
              arguments: {
                paneId,
                cursor: seeded.cursor,
                patterns: ["unprinted-eof-lifecycle-marker"],
                timeoutMs: state === "active" ? 30_000 : 25,
              },
            })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
          if (state === "completed") {
            const result = await waiting;
            expect("value" in result).toBe(true);
            if ("value" in result) {
              expect(structured<{ outcome: string }>(result.value).outcome).toBe("timed_out");
            }
          } else {
            expect(
              (await client.callTool({ name: "get_server_info", arguments: {} })).isError,
            ).not.toBe(true);
          }
          endInput();
          expect(await boundedExit(exited), stderr()).toEqual({ code: 0, signal: null });
          await waiting;
          expect(await keeper()).toBe(before);
          expect((await clients()).trim()).toBe("");
          expect(await Promise.all(controlPids.map(readProcessIdentity))).toEqual(
            identities.map(() => undefined),
          );
        });
      });
    },
    15_000,
  );

  test.each([
    { name: "immediate EOF", script: "const { main } = await import(entry); await main();" },
    {
      name: "EOF observed before main starts",
      script: `
        const ended = new Promise((resolve) => process.stdin.once("end", resolve));
        process.stdin.resume();
        await ended;
        const { main } = await import(entry);
        await main();
      `,
    },
    {
      name: "protocol close during connect",
      script: `
        const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
        const start = StdioServerTransport.prototype.start;
        StdioServerTransport.prototype.start = async function () {
          await start.call(this);
          await this.close();
        };
        const { main } = await import(entry);
        await main();
      `,
    },
  ])(
    `${runtime} main joins $name`,
    async ({ name, script }) => {
      await withServer(async (fixture) => {
        await withProgram(
          fixture,
          runtime,
          async ({ endInput, exited, stderr }) => {
            if (name !== "protocol close during connect") endInput();
            expect(await boundedExit(exited), stderr()).toEqual({ code: 0, signal: null });
          },
          script,
        );
      });
    },
    15_000,
  );

  test.each([
    {
      name: "connect failure",
      message: "stdio-start-probe",
      script: `
        const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
        StdioServerTransport.prototype.start = async function () {
          throw new Error("stdio-start-probe");
        };
        const { main } = await import(entry);
        await main();
      `,
    },
    {
      name: "backend close failure",
      message: "backend-close-probe",
      script: `
        const { LiveHub } = await import(new URL("./live.js", entry));
        LiveHub.prototype.close = async function () {
          throw new Error("backend-close-probe");
        };
        const { main } = await import(entry);
        await main();
      `,
    },
  ])(
    `${runtime} main preserves $name`,
    async ({ message, script }) => {
      await withServer(async (fixture) => {
        await withProgram(
          fixture,
          runtime,
          async ({ endInput, exited, stderr }) => {
            endInput();
            expect(await boundedExit(exited), stderr()).toEqual({ code: 1, signal: null });
            expect(stderr()).toContain(message);
          },
          script,
        );
      });
    },
    15_000,
  );
}
