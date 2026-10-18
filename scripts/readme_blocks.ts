/**
 * Fenced blocks and shell transcripts of a Markdown document.
 *
 * The suites that execute what a README tells a reader to type — the MCP
 * launch lines and the `tmux-workspace` commands — read the document through
 * this one parser, so a fence is the same fence to both.
 */

export interface Fence {
  /** The text after the opening backticks, such as `console` or `json`. */
  readonly language: string;
  /** The body of the fence, one entry per line. */
  readonly lines: readonly string[];
  /** The one-based line of the first body line. */
  readonly line: number;
  /** The nearest non-blank line above the opening backticks. */
  readonly lead: string;
}

/** Every fenced block, in document order. */
export function fences(markdown: string, file = "document"): readonly Fence[] {
  const found: Fence[] = [];
  let open: { language: string; lead: string; line: number; lines: string[] } | undefined;
  let lead = "";
  for (const [index, raw] of markdown.split("\n").entries()) {
    const line = raw.trimEnd();
    const marker = /^\s*```(?<language>\w*)\s*$/u.exec(line);
    if (open === undefined) {
      if (marker !== null) {
        open = { language: marker.groups?.["language"] ?? "", lead, line: index + 2, lines: [] };
      } else if (line.trim() !== "") {
        lead = line.trim();
      }
      continue;
    }
    if (marker !== null && marker.groups?.["language"] === "") {
      found.push(open);
      open = undefined;
      lead = "";
      continue;
    }
    open.lines.push(raw);
  }
  if (open !== undefined) throw new Error(`${file}: unterminated fence at line ${open.line - 1}`);
  return found;
}

export interface Step {
  /** The command with `\` continuations joined and the `$ ` prompt removed. */
  readonly command: string;
  /** The one-based line the command starts on. */
  readonly line: number;
  /** The lines printed under the command, up to the next prompt. */
  readonly output: readonly string[];
}

/** The commands of a `console` fence and what each is shown printing. */
export function steps(fence: Fence): readonly Step[] {
  const found: { command: string; line: number; output: string[] }[] = [];
  let continuing = false;
  for (const [index, raw] of fence.lines.entries()) {
    const line = raw.trimEnd();
    const current = found.at(-1);
    if (continuing && current !== undefined) {
      current.command += ` ${line.replace(/\\$/u, "").trim()}`;
      continuing = line.endsWith("\\");
      continue;
    }
    if (line.startsWith("$ ")) {
      const command = line.slice(2);
      found.push({
        command: command.replace(/\\$/u, "").trim(),
        line: fence.line + index,
        output: [],
      });
      continuing = command.endsWith("\\");
      continue;
    }
    if (current !== undefined && line !== "") current.output.push(line);
  }
  return found;
}

/**
 * Split a command line the way a POSIX shell would for the simple lines a
 * README shows: whitespace separates words, and quotes group them.
 */
export function words(command: string): readonly string[] {
  const found: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word = (word ?? "") + character;
    } else if (character === "'" || character === '"') {
      quote = character;
      word ??= "";
    } else if (/\s/u.test(character)) {
      if (word !== undefined) found.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + character;
    }
  }
  if (quote !== undefined) throw new Error(`unterminated quote in: ${command}`);
  if (word !== undefined) found.push(word);
  return found;
}
