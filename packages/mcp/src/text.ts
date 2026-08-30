/**
 * Turning a pane's byte stream into text worth reading.
 *
 * A pane writes for a terminal, not for a reader: the bytes carry cursor
 * movement, colour, and repaint alongside the characters. A shell that colours
 * its input puts an escape between every pair of letters, so a pattern matched
 * against the raw stream matches only when nothing coloured it.
 *
 * This is not a terminal. It removes the sequences that sit between characters
 * and turns carriage returns into line breaks, so a line rewritten in place
 * reads as a later line rather than running into the one it replaced. What it
 * cannot do is resolve cursor addressing: a program that draws by moving the
 * cursor comes out here in the order it was written, not the order it appears.
 * `capture_pane` reads tmux's rendered grid and is the answer when that matters.
 *
 * Ported from the same filter in libtmux-rs, which this shares a wire format
 * with. Stateful on purpose — tmux splits its notifications wherever it likes,
 * so an escape sequence can straddle two of them.
 */

const ESCAPE = 0x1b;
const BELL = 0x07;
const BACKSPACE = 0x08;

/** An escape sequence's intermediate bytes, which precede its final one. */
function isIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

type State =
  | "control-sequence"
  | "escape"
  | "escape-intermediate"
  | "string"
  | "string-escape"
  | "text";

/** Strips escape sequences from a pane's output, across chunk boundaries. */
export class TextFilter {
  #state: State = "text";
  /** The readable code points on the line currently being emitted. */
  readonly #line: string[] = [];
  #lineBytes = 0;
  #lineHead = 0;
  readonly #lineLimit: number;
  /** Whether the last byte was a carriage return, which decides the next break. */
  #pendingReturn = false;

  constructor(lineLimit: number = 256 * 1024) {
    if (!Number.isSafeInteger(lineLimit) || lineLimit < 0) {
      throw new RangeError("text filter line limit must be a non-negative safe integer");
    }
    this.#lineLimit = lineLimit;
  }

  /** The readable text of one chunk. */
  push(chunk: string): string {
    let out = "";
    for (const character of chunk) {
      out = this.#pushCharacter(character, out);
    }
    return out;
  }

  #pushCharacter(character: string, out: string): string {
    const code = character.codePointAt(0) ?? 0;
    switch (this.#state) {
      case "text": {
        return this.#pushTextCharacter(character, code, out);
      }
      case "escape": {
        if (character === "[") this.#state = "control-sequence";
        // OSC, APC, PM and DCS all run to a string terminator.
        else if (character === "]" || character === "_" || character === "^" || character === "P") {
          this.#state = "string";
        }
        // An intermediate byte means the final one is still to come. Treating
        // it as the end emitted the final byte as text, and `ESC ( B` is how
        // xterm's `sgr0` starts — so a `tput sgr0` left a `B` in the output.
        else if (isIntermediate(code)) this.#state = "escape-intermediate";
        else this.#state = "text";
        return out;
      }
      case "escape-intermediate": {
        // Intermediates may repeat; the first byte that is not one ends the
        // sequence and is consumed with it.
        if (!isIntermediate(code)) this.#state = "text";
        return out;
      }
      case "control-sequence": {
        if (code >= 0x40 && code <= 0x7e) this.#state = "text";
        return out;
      }
      case "string": {
        if (code === BELL) this.#state = "text";
        else if (code === ESCAPE) this.#state = "string-escape";
        return out;
      }
      case "string-escape": {
        // `ESC \` ends the string; any other ESC-something goes back to waiting
        // for a terminator rather than ending it.
        this.#state = character === "\\" ? "text" : "string";
        return out;
      }
    }
  }

  #pushTextCharacter(character: string, code: number, out: string): string {
    if (code === ESCAPE) {
      this.#state = "escape";
      return out;
    }
    if (character === "\r") {
      // Held: `\r\n` is one line break, and a lone `\r` is a line rewritten in
      // place, which reads better as another line than as text over the old.
      this.#pendingReturn = true;
      return out;
    }
    if (character === "\n") {
      this.#pendingReturn = false;
      this.#clearLine();
      return `${out}\n`;
    }
    if (code === BACKSPACE) {
      // A backspace is how a shell erases; dropping the erased character keeps
      // a re-edited command line from reading as both versions at once.
      const flushed = this.#flushReturn(out);
      if (!this.#popLine()) return flushed;
      const local = flushed.slice(flushed.lastIndexOf("\n") + 1);
      if (local !== "") return withoutLastCodePoint(flushed);
      // Text returned by an earlier push cannot be retracted. Emit the corrected
      // line as a later terminal rewrite instead of corrupting or ignoring it.
      return `${flushed}\n${this.#line.slice(this.#lineHead).join("")}`;
    }
    const flushed = this.#flushReturn(out);
    this.#appendLine(character);
    return flushed + character;
  }

  #flushReturn(out: string): string {
    if (!this.#pendingReturn) return out;
    this.#pendingReturn = false;
    this.#clearLine();
    return `${out}\n`;
  }

  #appendLine(character: string): void {
    const bytes = Buffer.byteLength(character, "utf8");
    this.#line.push(character);
    this.#lineBytes += bytes;
    while (this.#lineBytes > this.#lineLimit && this.#lineHead < this.#line.length) {
      const removed = this.#line[this.#lineHead] ?? "";
      this.#line[this.#lineHead] = "";
      this.#lineHead += 1;
      this.#lineBytes -= Buffer.byteLength(removed, "utf8");
    }
    if (this.#lineHead >= 64 && this.#lineHead * 2 >= this.#line.length) {
      this.#line.splice(0, this.#lineHead);
      this.#lineHead = 0;
    }
  }

  #clearLine(): void {
    this.#line.length = 0;
    this.#lineBytes = 0;
    this.#lineHead = 0;
  }

  #popLine(): boolean {
    if (this.#lineHead >= this.#line.length) return false;
    const removed = this.#line.pop();
    this.#lineBytes -= Buffer.byteLength(removed ?? "", "utf8");
    if (this.#lineHead >= this.#line.length) this.#clearLine();
    return true;
  }
}

function withoutLastCodePoint(value: string): string {
  if (value === "") return value;
  const last = value.charCodeAt(value.length - 1);
  const paired =
    last >= 0xdc00 &&
    last <= 0xdfff &&
    value.length >= 2 &&
    value.charCodeAt(value.length - 2) >= 0xd800 &&
    value.charCodeAt(value.length - 2) <= 0xdbff;
  return value.slice(0, paired ? -2 : -1);
}
