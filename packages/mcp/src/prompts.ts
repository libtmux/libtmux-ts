/**
 * Recipes, as the protocol's own way of packaging one.
 *
 * A prompt is what a person picks from a menu, so these cover the jobs somebody
 * asks for by name rather than every tool combination that exists. Each one
 * teaches the tool that makes the job cheap, because the expensive way is
 * always the one an agent reaches for first.
 */

import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "./context.js";

function userPrompt(text: string): {
  messages: { content: { text: string; type: "text" }; role: "user" }[];
} {
  return { messages: [{ content: { text, type: "text" }, role: "user" }] };
}

export function registerPrompts(mcp: McpServer, context: ToolContext): void {
  const completePaneId = async (value: string): Promise<string[]> =>
    (await context.snapshot()).panes
      .toArray()
      .map((pane) => pane.id)
      .filter((candidate) => candidate.startsWith(value));

  mcp.registerPrompt(
    "run-and-check",
    {
      argsSchema: {
        command: z.string().describe("The shell command to run."),
        paneId: completable(z.string().describe("Pane to run it in, e.g. %1."), completePaneId),
      },
      description: "Run a command in a pane and report whether it worked.",
      title: "Run a command and check it",
    },
    ({ command, paneId }) =>
      userPrompt(
        `Run this in tmux pane ${paneId} and tell me whether it succeeded:\n\n` +
          `    ${command}\n\n` +
          `Use run_command(paneId="${paneId}", command=...). Read exitStatus and outcome from ` +
          `the result — do not infer success from the text. If outcome is "timed_out" the ` +
          `command is still running. Do not call run_command again: that sends the command a ` +
          `second time. Use wait_for_text or observe to watch later output, or send_keys C-c to ` +
          `stop it. ` +
          `Do not use send_keys and capture_pane for this; they cannot tell you the exit status ` +
          `and they mistake the pane's echo of the command for its output.`,
      ),
  );

  mcp.registerPrompt(
    "watch-until",
    {
      argsSchema: {
        expect: z.string().describe("Text that means the thing you are waiting for happened."),
        paneId: completable(z.string().describe("Pane to watch."), completePaneId),
      },
      description: "Watch a pane that something else is writing to, until it says a thing.",
      title: "Watch a pane",
    },
    ({ expect, paneId }) =>
      userPrompt(
        `Watch tmux pane ${paneId} until it prints ${JSON.stringify(expect)}, then tell me what happened.\n\n` +
          `Use wait_for_text(paneId="${paneId}", patterns=["${expect}"]) — it streams tmux's ` +
          `notifications, so it costs nothing while nothing is happening. Never loop capture_pane.\n\n` +
          `If it returns outcome="timed_out", the output field still holds everything the pane ` +
          `printed and cursor marks where you got to: call again with that cursor rather than ` +
          `starting from scratch. If your client supports tasks, wait_for_text_task with a large ` +
          `timeoutMs hands you a handle immediately so you can do other work meanwhile. ` +
          `outcome="pane_died" means waiting again cannot help.`,
      ),
  );

  mcp.registerPrompt(
    "diagnose-pane",
    {
      argsSchema: {
        paneId: completable(z.string().describe("The pane that is misbehaving."), completePaneId),
      },
      description: "Work out what went wrong in a pane.",
      title: "Diagnose a pane",
    },
    ({ paneId }) =>
      userPrompt(
        `Something went wrong in tmux pane ${paneId}. Work out what.\n\n` +
          `1. get_pane(paneId="${paneId}") — what is it running, and is it dead?\n` +
          `2. capture_pane(paneId="${paneId}", start=-200) — the screen and some scrollback.\n` +
          `3. If you need to keep looking as it changes, observe(paneId="${paneId}") once, then ` +
          `pass the cursor it returns to each later call so you are only shown what is new.\n` +
          `4. Name the last command that ran and the last non-empty output line.\n\n` +
          `Give me a root-cause hypothesis and the single cheapest command that would confirm it. ` +
          `Do not run anything yet.`,
      ),
  );

  mcp.registerPrompt(
    "build-workspace",
    {
      argsSchema: {
        sessionName: z.string().describe("Name for the new session."),
        windows: z.string().describe("Comma-separated window names, e.g. edit,test,logs."),
      },
      description: "Build a session with several windows in as few calls as possible.",
      title: "Build a workspace",
    },
    ({ sessionName, windows }) =>
      userPrompt(
        `Build a tmux session called ${JSON.stringify(sessionName)} with windows: ${windows}.\n\n` +
          `Use build_workspace — it creates the session and every window in one tmux invocation ` +
          `and hands back every pane id, so you do not need new_window per window or a list_panes ` +
          `afterwards. Report the pane id for each window so I can target them.`,
      ),
  );
}
