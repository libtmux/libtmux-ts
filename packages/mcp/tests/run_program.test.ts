import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { structured, withClient, withServer } from "./support/server_harness.js";
import { tmuxReaches } from "../../libtmux/tests/support/tmux_release.js";

interface Ran {
  readonly exitStatus: number | null;
  readonly outcome: string;
  readonly output: string;
  readonly outputComplete: boolean;
  readonly signal: string | null;
  readonly stderr: string | null;
}

/** Program runs need tmux 3.8, candidates refused; below it the tool answers with the refusal. */
const supported = tmuxReaches("3.8");
const testProgram = supported ? test : test.skip;

async function programSessions(
  callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>,
): Promise<number> {
  const listed = structured<{ sessions: { name: string }[] }>(
    await callTool({ arguments: {}, name: "list_sessions" }),
  );
  return listed.sessions.filter((session) => session.name.startsWith("libtmux-program-")).length;
}

test("run_program refuses below tmux 3.8", async () => {
  if (supported) return;
  await withServer(async (fixture) => {
    await withClient(fixture, async (client) => {
      const answer = await client.callTool({ arguments: { argv: ["true"] }, name: "run_program" });
      expect(answer.isError).toBe(true);
      expect(JSON.stringify(answer.content)).toContain("3.8");
      expect(JSON.stringify(answer.content)).toContain("run_shell_command");
    });
  });
}, 40_000);

testProgram(
  "run_program returns only the program's output and exit status",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call = (request: { name: string; arguments: Record<string, unknown> }) =>
          client.callTool(request);
        const ran = structured<Ran>(
          await call({
            arguments: { argv: ["sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] },
            name: "run_program",
          }),
        );
        expect(ran).toMatchObject({
          exitStatus: 3,
          outcome: "completed",
          output: "one\ntwo",
          outputComplete: true,
          signal: null,
        });
        // argv is never a shell command line, and a start directory is never a format.
        const literal = structured<Ran>(
          await call({ arguments: { argv: ["echo", "$HOME", "#{pane_id}"] }, name: "run_program" }),
        );
        expect(literal.output).toBe("$HOME #{pane_id}");
        // A leading NAME=VALUE is a program name here, which env would have run as an assignment.
        const assignment = structured<Ran>(
          await call({ arguments: { argv: ["FOO=bar"] }, name: "run_program" }),
        );
        expect(assignment.exitStatus).toBe(127);
        // stderr shares the terminal unless kept apart.
        const talking = ["sh", "-c", "echo data; echo noise >&2"];
        const merged = structured<Ran>(
          await call({ arguments: { argv: talking }, name: "run_program" }),
        );
        expect(merged).toMatchObject({ output: "data\nnoise", stderr: null });
        const apart = structured<Ran>(
          await call({ arguments: { argv: talking, separateStderr: true }, name: "run_program" }),
        );
        expect(apart).toMatchObject({ output: "data", outputComplete: true, stderr: "noise" });
        expect(await programSessions(call)).toBe(0);
      });
    });
  },
  40_000,
);

testProgram(
  "run_program ends a program at its timeout",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const call = (request: { name: string; arguments: Record<string, unknown> }) =>
          client.callTool(request);
        const ran = structured<Ran>(
          await call({
            arguments: { argv: ["sh", "-c", "echo started; sleep 30"], timeoutMs: 2_000 },
            name: "run_program",
          }),
        );
        expect(ran).toMatchObject({
          exitStatus: null,
          outcome: "timed_out",
          output: "started",
          outputComplete: false,
        });
        expect(await programSessions(call)).toBe(0);
      });
    });
  },
  40_000,
);

testProgram(
  "run_program reports truncated scrollback and maxLines",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const ran = structured<Ran & { droppedLines: number }>(
          await client.callTool({
            arguments: { argv: ["seq", "1", "50"], maxLines: 5 },
            name: "run_program",
          }),
        );
        expect(ran.output).toBe("46\n47\n48\n49\n50");
        expect(ran.droppedLines).toBe(45);
        expect(ran.outputComplete).toBe(false);
      });
    });
  },
  40_000,
);

testProgram(
  "run_program fromPaneId starts in that pane's directory and session",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const created = structured<{ paneId: string }>(
          await client.callTool({
            arguments: { name: "work", startDirectory: "/" },
            name: "create_session",
          }),
        );
        await fixture.executeText(["set-environment", "-t", "=work", "PROJECT_ENV", "inherited"]);
        const ran = structured<Ran>(
          await client.callTool({
            arguments: {
              argv: ["sh", "-c", 'echo "$(pwd) $PROJECT_ENV"'],
              fromPaneId: created.paneId,
            },
            name: "run_program",
          }),
        );
        expect(ran.output).toBe("/ inherited");
        const refused = await client.callTool({
          arguments: { argv: ["true"], fromPaneId: created.paneId, width: 80 },
          name: "run_program",
        });
        expect(refused.isError).toBe(true);
        // A leading - is an option to a shell's exec; the schema says so before tmux runs.
        const dashed = await client.callTool({ arguments: { argv: ["-l"] }, name: "run_program" });
        expect(dashed.isError).toBe(true);
      });
    });
  },
  40_000,
);

testProgram(
  "run_program takes a start directory literally",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const literal = join(tmpdir(), `ltx-mcp-#{pane_id}-${String(process.pid)}`);
        await mkdir(literal, { recursive: true });
        try {
          const ran = structured<Ran>(
            await client.callTool({
              arguments: { argv: ["pwd", "-P"], startDirectory: literal },
              name: "run_program",
            }),
          );
          expect(ran.output).toBe(await realpath(literal));
        } finally {
          await rm(literal, { force: true, recursive: true });
        }
      });
    });
  },
  40_000,
);

testProgram(
  "run_program splits beside a pane, keeps it on request, and takes stdin",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        const created = structured<{ paneId: string }>(
          await client.callTool({ arguments: { name: "work" }, name: "create_session" }),
        );
        const sorted = structured<Ran>(
          await client.callTool({
            arguments: { argv: ["sort"], input: "pear\napple\n" },
            name: "run_program",
          }),
        );
        expect(sorted.output).toBe("apple\npear");
        const kept = structured<Ran>(
          await client.callTool({
            arguments: {
              argv: ["echo", "for you"],
              fromPaneId: created.paneId,
              keep: true,
              placement: "split",
            },
            name: "run_program",
          }),
        );
        expect(kept.exitStatus).toBe(0);
        const panes = await fixture.executeText([
          "list-panes",
          "-t",
          "=work:",
          "-F",
          "#{pane_dead} #{pane_id}",
        ]);
        expect(panes.stdout.filter((line) => line.startsWith("1 "))).toHaveLength(1);
        const refused = await client.callTool({
          arguments: { argv: ["true"], placement: "split" },
          name: "run_program",
        });
        expect(refused.isError).toBe(true);
      });
    });
  },
  40_000,
);

testProgram(
  "run_program inheritShell carries what the pane's shell exported",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // A shell started with the variable in its environment, which tmux's own lacks.
        const [paneId = ""] = (
          await fixture.executeText([
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-s",
            "shell",
            "--",
            "env",
            "LTX_SECRET=a b'c",
            "sh",
          ])
        ).stdout;
        const created = { paneId };
        const exported = structured<Ran>(
          await client.callTool({
            arguments: { command: "printenv LTX_SECRET", paneId: created.paneId },
            name: "run_shell_command",
          }),
        );
        expect(exported.output).toBe("a b'c");
        const plain = structured<Ran>(
          await client.callTool({
            arguments: { argv: ["sh", "-c", 'echo "[$LTX_SECRET]"'], fromPaneId: created.paneId },
            name: "run_program",
          }),
        );
        expect(plain.output).toBe("[]");
        const inherited = structured<Ran>(
          await client.callTool({
            arguments: {
              argv: ["sh", "-c", 'echo "[$LTX_SECRET] $TMUX_PANE"'],
              fromPaneId: created.paneId,
              inheritShell: true,
            },
            name: "run_program",
          }),
        );
        expect(inherited.output.startsWith("[a b'c] %")).toBe(true);
        // What the shell sets about itself stays behind: PWD is the program's directory.
        const placed = structured<Ran>(
          await client.callTool({
            arguments: {
              argv: ["printenv", "PWD"],
              fromPaneId: created.paneId,
              inheritShell: true,
              startDirectory: "/",
            },
            name: "run_program",
          }),
        );
        expect(placed.output).toBe("/");
        // A list carries only the names it gives.
        const listed = structured<Ran>(
          await client.callTool({
            arguments: {
              argv: ["sh", "-c", 'echo "[$LTX_SECRET]"'],
              fromPaneId: created.paneId,
              inheritShell: ["PATH"],
            },
            name: "run_program",
          }),
        );
        expect(listed.output).toBe("[]");
        expect(inherited.output).not.toContain(created.paneId);
        expect(await programSessions((request) => client.callTool(request))).toBe(0);
      });
    });
  },
  40_000,
);

testProgram(
  "wait_for_exit reports a pane's exit and a pane that was killed",
  async () => {
    await withServer(async (fixture) => {
      await withClient(fixture, async (client) => {
        // Panes someone else started: the MCP's own create_session takes no command.
        const started = async (name: string, command: string): Promise<string> =>
          (
            await fixture.executeText([
              "new-session",
              "-d",
              "-P",
              "-F",
              "#{pane_id}",
              "-s",
              name,
              command,
            ])
          ).stdout[0] ?? "";
        const created = { paneId: await started("build", "sleep 1; exit 5") };
        const exited = structured<{ exitStatus: number | null; outcome: string }>(
          await client.callTool({ arguments: { paneId: created.paneId }, name: "wait_for_exit" }),
        );
        expect(exited).toMatchObject({ exitStatus: 5, outcome: "completed" });
        const slow = { paneId: await started("slow", "sleep 30") };
        const timedOut = structured<{ outcome: string }>(
          await client.callTool({
            arguments: { paneId: slow.paneId, timeoutMs: 500 },
            name: "wait_for_exit",
          }),
        );
        expect(timedOut.outcome).toBe("timed_out");
        const waiting = client.callTool({
          arguments: { paneId: slow.paneId },
          name: "wait_for_exit",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await fixture.executeText(["kill-pane", "-t", slow.paneId]);
        expect(structured<{ outcome: string }>(await waiting).outcome).toBe("gone");
      });
    });
  },
  40_000,
);
