import type { CommandOptions } from "../../common.js";
import { TmuxCommandError, TmuxTransportError } from "../../exc.js";
import type { TmuxVersion } from "../../types.js";
import type { RuntimeContext } from "../runtime/context.js";
import { parseTmuxVersion, tmuxVersionAtLeast } from "../runtime/tmux_version.js";
import { runCommand } from "./command.js";

const classicNames = [
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
  "tiled",
];
const mirroredNames = [...classicNames, "main-horizontal-mirrored", "main-vertical-mirrored"];
const beforeMirrors = parseTmuxVersion("3.4");
const withMirrors = parseTmuxVersion("3.5");

/** Geometry correction and pruning remain tmux's responsibility. */
export function layoutIsValid(layout: string, panes: number, version: TmuxVersion): boolean {
  if (!Number.isSafeInteger(panes) || panes < 1 || layout.length === 0) return false;
  const names = tmuxVersionAtLeast(version, withMirrors) ? mirroredNames : classicNames;
  if (names.includes(layout) || names.filter((name) => name.startsWith(layout)).length === 1)
    return true;
  if (layout.length > 8192 || !/^[0-9a-fA-F]{4},/u.test(layout)) return false;
  const body = layout.slice(5);
  let checksum = 0;
  for (const character of body)
    checksum = (((checksum >>> 1) | ((checksum & 1) << 15)) + character.charCodeAt(0)) & 0xffff;
  if (checksum !== Number.parseInt(layout.slice(0, 4), 16)) return false;
  const parser = new LayoutParser(body);
  return parser.cell(0) && parser.offset === body.length && parser.leaves >= panes;
}

export async function validateLayouts(
  runtime: RuntimeContext,
  layouts: readonly { readonly layout: string; readonly panes: number }[],
  options: CommandOptions = {},
): Promise<void> {
  if (options.signal?.aborted === true)
    throw new TmuxTransportError("layout validation cancelled", {
      delivery: "not_started",
      kind: "cancelled",
      subcommand: "display-message",
    });
  const needsVersion: { layout: string; panes: number }[] = [];
  for (const { layout, panes } of layouts) {
    const before = layoutIsValid(layout, panes, beforeMirrors);
    const after = layoutIsValid(layout, panes, withMirrors);
    if (!before && !after) throw new TypeError(`invalid tmux layout or pane count: ${layout}`);
    if (before !== after) needsVersion.push({ layout, panes });
  }
  if (needsVersion.length === 0) return;
  let version: TmuxVersion;
  try {
    version = parseTmuxVersion(
      (await runCommand(runtime, ["display-message", "-p", "#{version}"], options))
        .join("\n")
        .trim(),
    );
  } catch (error) {
    if (!(error instanceof TmuxCommandError)) throw error;
    const reason = error.stderr.join("\n").trim();
    if (
      !(
        reason.startsWith("no server running on ") ||
        (reason.startsWith("error connecting to ") &&
          reason.endsWith(" (No such file or directory)"))
      )
    )
      throw error;
    const client = (await runCommand(runtime, ["-V"], options)).join("\n").trim();
    version = parseTmuxVersion(client.startsWith("tmux ") ? client.slice(5) : client);
  }
  for (const { layout, panes } of needsVersion) {
    if (!layoutIsValid(layout, panes, version))
      throw new TypeError(`invalid tmux layout for ${version.raw}: ${layout}`);
  }
}

class LayoutParser {
  offset = 0;
  leaves = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private take(character: string): boolean {
    if (this.text[this.offset] !== character) return false;
    this.offset++;
    return true;
  }

  private number(): boolean {
    const start = this.offset;
    let value = 0;
    while (this.offset < this.text.length) {
      const digit = this.text.charCodeAt(this.offset) - 48;
      if (digit < 0 || digit > 9) break;
      value = value * 10 + digit;
      if (value > 0xffff_ffff) return false;
      this.offset++;
    }
    return this.offset > start;
  }

  cell(depth: number): boolean {
    if (
      depth > 256 ||
      !this.number() ||
      !this.take("x") ||
      !this.number() ||
      !this.take(",") ||
      !this.number() ||
      !this.take(",") ||
      !this.number()
    )
      return false;
    const saved = this.offset;
    if (this.take(",") && (!this.number() || this.text[this.offset] === "x")) this.offset = saved;
    const close = this.take("{") ? "}" : this.take("[") ? "]" : undefined;
    if (close === undefined) {
      this.leaves++;
      return true;
    }
    if (!this.cell(depth + 1)) return false;
    while (this.take(",")) if (!this.cell(depth + 1)) return false;
    return this.take(close);
  }
}
