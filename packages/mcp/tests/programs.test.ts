/* eslint-disable no-await-in-loop -- tests poll and read sequentially */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { serverFor, structured, withClient, withServer } from "./support/server_harness.js";
import { tmuxReaches } from "../../libtmux/tests/support/tmux_release.js";
import { MAX_RESULT_BYTES } from "../src/policy.js";
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
  readonly outputCut: boolean;
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
        expect(reads[firstLine]).toMatchObject({ ended: false, outputComplete: false });
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
        // A program that never ran starts, then reads as not_started with the shell's status.
        const missing = structured<Started>(
          await call({ arguments: { argv: ["ltx-no-such-program"] }, name: "start_program" }),
        );
        expect((await readAll(call, missing.programId, 5000)).at(-1)).toMatchObject({
          ended: true,
          exitStatus: 127,
          outcome: "not_started",
        });
        await call({ arguments: { programId: missing.programId }, name: "stop_program" });
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
        // 4 MiB arrives in pages of about 24,000 characters, and a read may come before it all has.
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

testProgram(
  "read_program keeps a capped amount of text, however much a backspace re-emits",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        // Each late backspace re-emits the line's last 256 KiB: twenty of them pass 4 MiB kept.
        const argv = [
          "sh",
          "-c",
          "printf '%262144s' '' | tr ' ' x; n=0; while [ $n -lt 20 ]; do sleep 0.1; printf '\\b'; n=$((n + 1)); done",
        ];
        const started = structured<Started>(
          await call({ arguments: { argv, lifetimeMs: 30_000 }, name: "start_program" }),
        );
        const reads = await readAll(call, started.programId, 5000, 400);
        const kept = reads.reduce((total, read) => total + Buffer.byteLength(read.text), 0);
        expect(kept).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(reads.at(-1)).toMatchObject({ ended: true, outputComplete: false, outputCut: true });
        await call({ arguments: { programId: started.programId }, name: "stop_program" });
      });
    });
  },
  60_000,
);

testProgram(
  "read_program pages by a budget that keeps the whole result inline, and by maxLines",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const firstPage = async (
          script: string,
          extra: Record<string, unknown> = {},
        ): Promise<{ page: Read; size: number }> => {
          const started = structured<Started>(
            await call({
              arguments: { argv: ["sh", "-c", script], lifetimeMs: 30_000 },
              name: "start_program",
            }),
          );
          // Read once it has ended, so the first page is a full one.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const answer = await call({
            arguments: { programId: started.programId, timeoutMs: 5000, ...extra },
            name: "read_program",
          });
          await call({ arguments: { programId: started.programId }, name: "stop_program" });
          return { page: structured<Read>(answer), size: JSON.stringify(answer).length };
        };

        // Short lines: the budget, not a line count, ends the page, on a line break.
        const numbers = await firstPage("seq 1 200000");
        expect(numbers.page.text.endsWith("\n")).toBe(true);
        expect(numbers.page.text.split("\n").length).toBeGreaterThan(1000);
        expect(numbers.size).toBeLessThanOrEqual(50_000);
        // Long lines: the budget stops the page, on a line break.
        const wide = await firstPage("yes \"$(printf '%1000s' '' | tr ' ' x)\" | head -300");
        expect(wide.page.text.endsWith("\n")).toBe(true);
        expect(wide.page.text.length).toBeLessThan(25_000);
        expect(wide.size).toBeLessThanOrEqual(50_000);
        // Every character escaped to two: the bound is on the JSON, not the raw text.
        const quotes = await firstPage("yes \"$(printf '%200s' '' | tr ' ' '\"')\" | head -200");
        expect(quotes.page.text.length).toBeLessThan(12_500);
        expect(quotes.size).toBeLessThanOrEqual(50_000);
        // maxLines: that many lines, and a cursor that resumes after them.
        const three = await firstPage("seq 1 10", { maxLines: 3 });
        expect(three.page).toMatchObject({ cursor: 6, ended: false, text: "1\n2\n3\n" });
        const after = await firstPage("seq 1 10", { cursor: 6, maxLines: 2 });
        expect(after.page).toMatchObject({ cursor: 10, ended: false, text: "4\n5\n" });
      });
    });
  },
  60_000,
);

testProgram(
  "read_program pages so the model's text and the cursor cover the same bytes",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        // Just under the result ceiling, so a page and its status line together pass it.
        const argv = ["sh", "-c", "printf BEGIN-; printf '%999993s' '' | tr ' ' x"];
        const started = structured<Started>(
          await call({ arguments: { argv, lifetimeMs: 30_000 }, name: "start_program" }),
        );
        // Read once it has all arrived, so the first page is a full one.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let cursor = 0;
        let modelText = "";
        let structuredText = "";
        const pages: { readonly headline: string; readonly read: Read }[] = [];
        for (let read = 0; read < 200; read += 1) {
          const answer = (await call({
            arguments: { cursor, programId: started.programId, timeoutMs: 5000 },
            name: "read_program",
          })) as { content: { text: string }[]; structuredContent: Read };
          const shown = answer.content[0]?.text ?? "";
          expect(shown).not.toContain("omitted by the result ceiling");
          // The whole result, both copies of the text included, stays within the ceiling.
          expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
          modelText += shown.slice(0, shown.lastIndexOf("\n\n["));
          structuredText += answer.structuredContent.text;
          cursor = answer.structuredContent.cursor;
          pages.push({
            headline: shown.slice(shown.lastIndexOf("\n\n[")),
            read: answer.structuredContent,
          });
          if (answer.structuredContent.ended) break;
        }
        expect(modelText.startsWith("BEGIN-")).toBe(true);
        expect(modelText).toBe(structuredText);
        expect(cursor).toBe(999_999);
        // The program had exited before the first read: every page says how, and
        // only the last, with nothing after it, is ended.
        expect(pages.length).toBeGreaterThan(1);
        for (const [index, { headline, read }] of pages.entries()) {
          const last = index === pages.length - 1;
          expect(read).toMatchObject({ ended: last, exitStatus: 0, outcome: "completed" });
          expect(headline).toContain("exit 0");
          expect(headline.includes("more output after cursor")).toBe(!last);
        }
        await call({ arguments: { programId: started.programId }, name: "stop_program" });
      });
    });
  },
  60_000,
);

testProgram(
  "a program beside a person's pane keeps its split on screen after it ends, until stopped",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call: Call = (request) => client.callTool(request);
        const panes = async (): Promise<readonly string[]> =>
          (await fixture.executeText(["list-panes", "-a", "-F", "#{pane_id}"])).stdout;
        const created = structured<{ paneId: string }>(
          await call({ arguments: { name: "watched" }, name: "create_session" }),
        );
        const argv = ["sh", "-c", "echo build failed; exit 2"];
        const beside = structured<Started>(
          await call({
            arguments: { argv, fromPaneId: created.paneId, placement: "split" },
            name: "start_program",
          }),
        );
        const own = structured<Started>(await call({ arguments: { argv }, name: "start_program" }));
        for (const programId of [beside.programId, own.programId]) {
          expect((await readAll(call, programId, 5000)).at(-1)).toMatchObject({
            ended: true,
            exitStatus: 2,
          });
        }
        // Past the end: the split beside a person stays for them to read; the program's own goes.
        expect(await until(async () => !(await panes()).includes(own.paneId), 5000)).toBe(true);
        expect(await panes()).toContain(beside.paneId);
        await call({ arguments: { programId: beside.programId }, name: "stop_program" });
        expect(await panes()).not.toContain(beside.paneId);
        await call({ arguments: { programId: own.programId }, name: "stop_program" });
      });
    });
  },
  60_000,
);
