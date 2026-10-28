/* eslint-disable no-await-in-loop -- tests poll and read sequentially */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { serverFor, structured, withClient, withServer } from "./support/server_harness.js";
import { tmuxReaches } from "../../libtmux/tests/support/tmux_release.js";
import { readable } from "../src/tools/programs.js";

interface Started {
  readonly effectiveTimeoutMs: number;
  readonly paneId: string;
  readonly programId: string;
}

interface Read {
  readonly cursor: number;
  readonly lostEnd: boolean;
  readonly outcome: string;
  readonly outputComplete: boolean;
  readonly ended: boolean;
  readonly exitStatus: number | null;
  readonly signal: string | null;
  readonly text: string;
}

const testProgram = tmuxReaches("3.8") ? test : test.skip;
type Call = (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;

async function programSessions(call: Call): Promise<string[]> {
  const listed = structured<{ sessions: { name: string }[] }>(
    await call({ arguments: {}, name: "list_sessions" }),
  );
  return listed.sessions
    .map((session) => session.name)
    .filter((name) => name.startsWith("libtmux-program-"));
}

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

/** Read to the exit, returning every read in order. */
async function readAll(
  call: Call,
  programId: string,
  timeoutMs: number,
  maxReads = 100,
): Promise<Read[]> {
  const reads: Read[] = [];
  let cursor = 0;
  for (let i = 0; i < maxReads; i += 1) {
    const read = structured<Read>(
      await call({ arguments: { cursor, programId, timeoutMs }, name: "read_program" }),
    );
    reads.push(read);
    cursor = read.cursor;
    if (read.ended) return reads;
  }
  throw new Error("program never reported its exit");
}

test("a read never splits a character, wherever the limit falls", () => {
  // Three-byte characters, held in chunks split mid-character.
  const whole = Buffer.from("€€€€", "utf8");
  const chunks = [whole.subarray(0, 4), whole.subarray(4, 7), whole.subarray(7)];
  for (let limit = 1; limit <= whole.length; limit += 1) {
    let cursor = 0;
    let text = "";
    while (cursor < whole.length) {
      const read = readable(chunks, whole.length, cursor, Math.max(limit, 3));
      expect(read.text).not.toContain("\uFFFD");
      text += read.text;
      cursor = read.end;
    }
    expect(text).toBe("€€€€");
  }
});

const FIVE_LINES = ["sh", "-c", "for i in 1 2 3 4 5; do echo line$i; sleep 1; done; exit 0"];

testProgram(
  "read_program calls a pane removed from outside gone, its end unread",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const started = structured<Started>(
          await call({
            arguments: { argv: ["sh", "-c", "echo up; sleep 30"] },
            name: "start_program",
          }),
        );
        await serverFor(fixture).cmd("kill-pane", ["-t", started.paneId]);
        expect((await readAll(call, started.programId, 5000)).at(-1)).toMatchObject({
          ended: true,
          lostEnd: true,
          outcome: "gone",
          outputComplete: false,
        });
      });
    });
  },
  40_000,
);

testProgram(
  "read_program shows output before the exit, then the exit status",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const started = structured<Started>(
          await call({
            arguments: { argv: FIVE_LINES, lifetimeMs: 30_000 },
            name: "start_program",
          }),
        );
        const reads = await readAll(call, started.programId, 5000);
        const firstLine = reads.findIndex((read) => read.text.includes("line1"));
        expect(firstLine).toBeGreaterThanOrEqual(0);
        expect(reads[firstLine]?.ended).toBe(false);
        const text = reads.map((read) => read.text).join("");
        for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`line${String(n)}`);
        const last = reads.at(-1);
        expect(last).toMatchObject({
          exitStatus: 0,
          ended: true,
          outcome: "completed",
          signal: null,
        });
        // Output stays readable after the exit.
        const again = structured<Read>(
          await call({
            arguments: { cursor: 0, programId: started.programId },
            name: "read_program",
          }),
        );
        expect(again.text).toContain("line5");
        await call({ arguments: { programId: started.programId }, name: "stop_program" });
        expect(await programSessions(call)).toEqual([]);
      });
    });
  },
  60_000,
);

testProgram(
  "read_program says a stop ended it, and a copy past its limit is incomplete",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const sleeper = structured<Started>(
          await call({
            arguments: { argv: ["sh", "-c", "echo up; sleep 30"] },
            name: "start_program",
          }),
        );
        const reading = call({
          arguments: { cursor: 3, programId: sleeper.programId, timeoutMs: 10_000 },
          name: "read_program",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await call({ arguments: { programId: sleeper.programId }, name: "stop_program" });
        // The stop cut the copy, which is no loss of tmux's.
        expect(structured<Read>(await reading)).toMatchObject({
          ended: true,
          lostEnd: false,
          outcome: "stopped",
          outputComplete: false,
        });

        // Past the 4 MiB copy limit, the text is cut and the exit still arrives.
        const flood = structured<Started>(
          await call({ arguments: { argv: ["seq", "1", "1000000"] }, name: "start_program" }),
        );
        // 4 MiB arrives a megabyte per read at most, and a read may come before it all has.
        const reads = await readAll(call, flood.programId, 10_000, 1000);
        expect(reads.at(-1)).toMatchObject({ exitStatus: 0, ended: true, outputComplete: false });
        await call({ arguments: { programId: flood.programId }, name: "stop_program" });
      });
    });
  },
  60_000,
);

testProgram(
  "read_program and run_program say when the end may be missing",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        // USR1 ends the wrapper before its end mark, as a pane tmux removed early would.
        const argv = ["sh", "-c", "echo hi; kill -USR1 $PPID; sleep 1"];
        const started = structured<Started>(
          await call({ arguments: { argv }, name: "start_program" }),
        );
        const reads = await readAll(call, started.programId, 10_000);
        expect(reads.at(-1)).toMatchObject({ ended: true, outputComplete: false });
        await call({ arguments: { programId: started.programId }, name: "stop_program" });
        const ran = await call({ arguments: { argv }, name: "run_program" });
        expect(structured<{ outputComplete: boolean }>(ran).outputComplete).toBe(false);
        expect(JSON.stringify((ran as { content: unknown }).content)).toContain(
          "its end may be missing",
        );
      });
    });
  },
  60_000,
);

testProgram(
  "start_program refuses a seventeenth running program",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const started = await Promise.all(
          Array.from({ length: 17 }, () =>
            call({ arguments: { argv: ["sleep", "30"] }, name: "start_program" }),
          ),
        );
        const refused = started.filter(
          (answer) => (answer as { isError?: boolean }).isError === true,
        );
        expect(refused).toHaveLength(1);
        for (const answer of started) {
          if ((answer as { isError?: boolean }).isError === true) continue;
          const { programId } = structured<Started>(answer);
          await call({ arguments: { programId }, name: "stop_program" });
        }
        expect(await programSessions(call)).toEqual([]);
      });
    });
  },
  60_000,
);

testProgram(
  "stop_program and the lifetime each remove the program's session",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const stopped = structured<Started>(
          await call({ arguments: { argv: ["sleep", "30"] }, name: "start_program" }),
        );
        expect(await programSessions(call)).toHaveLength(1);
        await call({ arguments: { programId: stopped.programId }, name: "stop_program" });
        expect(await programSessions(call)).toEqual([]);

        // No later call: only the 2 s lifetime ends it.
        const short = structured<Started>(
          await call({
            arguments: { argv: ["sleep", "30"], lifetimeMs: 2000 },
            name: "start_program",
          }),
        );
        expect(await programSessions(call)).toHaveLength(1);
        expect(await until(async () => (await programSessions(call)).length === 0, 8000)).toBe(
          true,
        );
        // The lifetime ends it but keeps what it printed readable.
        const ended = structured<Read>(
          await call({ arguments: { programId: short.programId }, name: "read_program" }),
        );
        expect(ended).toMatchObject({
          ended: true,
          lostEnd: false,
          outcome: "expired",
          outputComplete: false,
        });
      });
    });
  },
  60_000,
);

testProgram(
  "a program longer than the wait ceiling is read whole across several calls",
  async () => {
    await withServer(async (fixture) => {
      await withClient(
        fixture,
        async (client) => {
          const call: Call = (request) => client.callTool(request);
          const started = structured<Started>(
            await call({
              arguments: {
                argv: ["sh", "-c", "echo start; sleep 5; echo end; exit 4"],
                lifetimeMs: 30_000,
              },
              name: "start_program",
            }),
          );
          const startedAt = Date.now();
          // Ask for far more than the 2 s ceiling.
          const reads = await readAll(call, started.programId, 60_000);
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4000);
          // The ceiling forced more than one wait for the silent 5 s.
          expect(reads.length).toBeGreaterThanOrEqual(3);
          expect(reads.map((read) => read.text).join("")).toContain("end");
          expect(reads.at(-1)).toMatchObject({ exitStatus: 4, ended: true });
          await call({ arguments: { programId: started.programId }, name: "stop_program" });
          expect(await programSessions(call)).toEqual([]);
        },
        { LIBTMUX_MCP_WAIT_MAX_MS: "2000" },
      );
    });
  },
  60_000,
);

testProgram(
  "tmux removes a started program once a killed server stops renewing its lease",
  async () => {
    await withServer(async (fixture) => {
      const client = new Client({ name: "probe", version: "0.0.0" });
      const transport = new StdioClientTransport({
        args: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
        command: process.execPath,
        env: {
          ...(process.env as Record<string, string>),
          ...fixture.controllerEnvironment,
          LIBTMUX_SOCKET_PATH: fixture.socketPath,
          LIBTMUX_TMUX_BIN: fixture.tmuxExecutable,
          LIBTMUX_TOOLSETS: "inspect,manage,execute,teardown",
        },
      });
      await client.connect(transport);
      structured(
        await client.callTool({
          arguments: { argv: ["sleep", "300"], lifetimeMs: 300_000 },
          name: "start_program",
        }),
      );
      const names = async (): Promise<string[]> =>
        (await serverFor(fixture).sessions()).toArray().map((session) => session.name ?? "");
      const live = async (): Promise<number> =>
        (await names()).filter((name) => name.startsWith("libtmux-program-")).length;
      expect(await live()).toBe(1);
      process.kill(transport.pid as number, "SIGKILL");
      // The lease is 30 s, renewed every 10 s, so tmux acts 20 to 30 s after the kill.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && (await live()) !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(await live()).toBe(0);
      await client.close().catch(() => undefined);
    });
  },
  70_000,
);
