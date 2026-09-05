import { LibTmuxException, WaitTimeout } from "../../exc.js";
import type { Pane } from "../../pane.js";
import type { RunOptions } from "../../types.js";
import { timerDuration } from "../timing.js";

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** CSI, OSC, and the DECSET fragments zsh injects while redrawing a line. */
const ansi =
  // eslint-disable-next-line no-control-regex -- tmux %output carries these bytes.
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|].*?(?:\x07|\x1b\\)|[=>])/g;

function applyBackspaces(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\b") out = out.slice(0, -1);
    else out += char;
  }
  return out;
}

function visibleText(text: string): string {
  return applyBackspaces(normalizeNewlines(text).replace(ansi, ""));
}

function isEchoLine(line: string, command: string): boolean {
  const plain = visibleText(line).trim();
  if (plain === "") return false;
  if (plain.includes(command)) return true;
  if (command.startsWith(plain)) return true;
  // zsh wraps a long command; the next complete line is the tail of the echo.
  if (plain.length >= 4 && command.endsWith(plain)) return true;
  return false;
}

/**
 * Printed output after dropping the shell's echo of `command`.
 *
 * Incomplete lines are the live echo of typing (zsh redraws with backspace)
 * and are not matched. A marker that lives only in the keys never appears here.
 */
export function afterSentKeysEcho(output: string, command: string): string {
  const out = normalizeNewlines(output);
  const cmd = normalizeNewlines(command);
  const newline = out.lastIndexOf("\n");
  const complete = newline < 0 ? "" : out.slice(0, newline);
  const lines = complete === "" ? [] : complete.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (isEchoLine(line, cmd)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export async function runPane(pane: Pane, command: string, options: RunOptions): Promise<string> {
  if (options.until === "") throw new TypeError("until must be a non-empty string");
  const timeoutMs =
    options.timeoutMs === undefined ? 30_000 : timerDuration("timeoutMs", options.timeoutMs);
  const session = pane.session;
  if (session === undefined) {
    throw new LibTmuxException("Pane.run attaches to the pane's session; this pane has none");
  }

  await using live = await pane.server.connect({
    target: session.id,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const events = live.subscribe();
  await events.ready();

  const paneId = pane.id;
  let seen = "";
  const matched = (async (): Promise<string> => {
    for await (const event of events) {
      if (event.kind !== "output" || event.paneId !== paneId) continue;
      seen += event.data;
      const after = afterSentKeysEcho(seen, command);
      if (after.includes(options.until)) return after;
    }
    throw new LibTmuxException("the tmux event stream ended before a match");
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new WaitTimeout(`Pane.run timed out waiting for ${JSON.stringify(options.until)}`));
    }, timeoutMs);
  });

  try {
    await pane.sendKeys(command, {
      literal: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await Promise.race([matched, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await events.close();
    await matched.catch(() => undefined);
  }
}
