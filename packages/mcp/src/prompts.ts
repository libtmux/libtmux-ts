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

import type { ToolContext } from "./context.js";
import { framedCommandText, inlineRequestText, paneIdSchema, requestText } from "./schemas.js";
import { paneEntities } from "./target_resolution.js";

function userPrompt(text: string): {
  messages: { content: { text: string; type: "text" }; role: "user" }[];
} {
  return { messages: [{ content: { text, type: "text" }, role: "user" }] };
}

export function registerPrompts(
  mcp: McpServer,
  context: ToolContext,
  registeredTools: ReadonlySet<string>,
): void {
  const completePaneId = async (value: string): Promise<string[]> =>
    paneEntities((await context.snapshot()).panes.toArray())
      .map((pane) => pane.id)
      .filter((candidate) => candidate.startsWith(value));

  const hasTools = (...required: readonly string[]): boolean =>
    required.every((name) => registeredTools.has(name));
  const whenTools = (...required: readonly string[]): McpServer | undefined =>
    hasTools(...required) ? mcp : undefined;

  const readers = context.policy.liveEnabled
    ? ["wait_for_text", "observe"].filter((name) => hasTools(name))
    : [];
  const runFollowup = [
    readers.length === 0 ? "" : `Use ${readers.join(" or ")} to watch later output.`,
    hasTools("send_keys")
      ? 'Use send_keys with keys="C-c", enter=false, and force=true to stop it.'
      : "",
    hasTools("send_keys", "capture_pane")
      ? "Do not use send_keys and capture_pane for this; they cannot tell you the exit status and they mistake the pane's echo of the command for its output."
      : "",
  ]
    .filter((text) => text !== "")
    .join(" ");

  whenTools("run_command")?.registerPrompt(
    "run-and-check",
    {
      argsSchema: {
        command: framedCommandText("command").describe("The shell command to run."),
        paneId: completable(paneIdSchema.describe("Pane to run it in, e.g. %1."), completePaneId),
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
          `second time.${runFollowup === "" ? "" : ` ${runFollowup}`}`,
      ),
  );

  whenTools("wait_for_text")?.registerPrompt(
    "watch-until",
    {
      argsSchema: {
        expect: requestText("expect").describe(
          "Text that means the thing you are waiting for happened.",
        ),
        paneId: completable(paneIdSchema.describe("Pane to watch."), completePaneId),
      },
      description: "Watch a pane that something else is writing to, until it says a thing.",
      title: "Watch a pane",
    },
    ({ expect, paneId }) =>
      userPrompt(
        `Watch tmux pane ${paneId} until it prints ${JSON.stringify(expect)}, then tell me what happened.\n\n` +
          `Use wait_for_text(paneId=${JSON.stringify(paneId)}, patterns=[${JSON.stringify(expect)}]) — it streams tmux's ` +
          `notifications, so it costs nothing while nothing is happening.${hasTools("capture_pane") ? " Never loop capture_pane." : ""}\n\n` +
          `If it returns outcome="timed_out", the output field still holds everything the pane ` +
          `printed and cursor marks where you got to: call again with that cursor rather than ` +
          `starting from scratch. outcome="pane_died" means waiting again cannot help.`,
      ),
  );

  whenTools("get_pane", "capture_pane")?.registerPrompt(
    "diagnose-pane",
    {
      argsSchema: {
        paneId: completable(paneIdSchema.describe("The pane that is misbehaving."), completePaneId),
      },
      description: "Work out what went wrong in a pane.",
      title: "Diagnose a pane",
    },
    ({ paneId }) =>
      userPrompt(
        `Something went wrong in tmux pane ${paneId}. Work out what.\n\n` +
          `1. get_pane(paneId="${paneId}") — what is it running, and is it dead?\n` +
          `2. capture_pane(paneId="${paneId}", start=-200) — the screen and some scrollback.\n` +
          (context.policy.liveEnabled && hasTools("observe")
            ? `3. If you need to keep looking as it changes, observe(paneId="${paneId}") once, then ` +
              `pass the cursor it returns to each later call so you are only shown what is new.\n`
            : "") +
          `${context.policy.liveEnabled && hasTools("observe") ? "4" : "3"}. Name the last command that ran and the last non-empty output line.\n\n` +
          `Give me a root-cause hypothesis and the single cheapest command that would confirm it. ` +
          `Do not run anything yet.`,
      ),
  );

  whenTools("build_workspace")?.registerPrompt(
    "build-workspace",
    {
      argsSchema: {
        sessionName: inlineRequestText("sessionName").describe("Name for the new session."),
        windows: requestText("windows").describe(
          "Comma-separated window names, e.g. edit,test,logs.",
        ),
      },
      description: "Build a session with several windows in as few calls as possible.",
      title: "Build a workspace",
    },
    ({ sessionName, windows }) =>
      userPrompt(
        `Build a tmux session called ${JSON.stringify(sessionName)} with windows: ${windows}.\n\n` +
          `Use build_workspace — it creates the session and every window with one final snapshot ` +
          `and hands back every pane id` +
          (hasTools("new_window", "list_panes")
            ? `, so you do not need new_window per window or a list_panes afterwards`
            : "") +
          `. Report the pane id for each window so I can target them.`,
      ),
  );
}
