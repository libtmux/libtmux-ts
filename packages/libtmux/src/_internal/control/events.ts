import type { TmuxEvent } from "../../types.js";

/**
 * Framing tmux writes around a command's response.
 *
 * tmux fences its own internal commands the same way it fences a control
 * client's, and sets the guard's flags to 1 only for the latter
 * (`CMDQ_STATE_CONTROL` in cmd-queue.c). Attaching alone emits one such block,
 * so a client that binds every block to a pending command answers its first
 * request with somebody else's reply.
 */
export type ControlBlockBoundary =
  | { readonly fromClient: boolean; readonly guard: GuardIdentity; readonly kind: "block-begin" }
  | {
      readonly failed: boolean;
      readonly fromClient: boolean;
      readonly guard: GuardIdentity;
      readonly kind: "block-end";
    };

/**
 * What ties a guard to the command it fences.
 *
 * The command number is the only field naming which command a guard belongs to,
 * and pairing on it is what stops a command's own output from closing its block
 * — tmux writes that output through `server_client_print` with no escaping of a
 * leading `%`, unlike a `%output` payload.
 *
 * Compared as text, never parsed: tmux prints the time as `%ld`, whose range
 * this side cannot rely on, and equality is all a pairing needs.
 */
export interface GuardIdentity {
  readonly number: string;
  readonly time: string;
}

const BACKSLASH = 0x5c;
const ZERO = 0x30;
const SEVEN = 0x37;

/**
 * Reverse the escaping tmux applies to `%output` payloads.
 *
 * tmux writes a byte below 0x20, and the backslash itself, as `\ooo` in octal
 * and passes every other byte through untouched. High bytes are therefore raw,
 * so unescaping has to happen before decoding or a multi-byte character split
 * across the escape boundary is corrupted.
 */
export function unescapeOutput(payload: Uint8Array): Uint8Array {
  if (!payload.includes(BACKSLASH)) return payload;
  const decoded = new Uint8Array(payload.length);
  let written = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const byte = payload[index]!;
    const digits = payload.subarray(index + 1, index + 4);
    if (
      byte === BACKSLASH &&
      digits.length === 3 &&
      digits.every((digit) => digit >= ZERO && digit <= SEVEN)
    ) {
      decoded[written++] = (digits[0]! - ZERO) * 64 + (digits[1]! - ZERO) * 8 + (digits[2]! - ZERO);
      index += 3;
      continue;
    }
    decoded[written++] = byte;
  }
  return decoded.subarray(0, written);
}

const decoder = new TextDecoder();

/**
 * How much of `bytes` ends on a complete UTF-8 character.
 *
 * tmux emits `%output` for whatever it read from the pty, so a multi-byte
 * character can straddle two notifications. Decoding each one on its own turns
 * the halves into replacement characters, which is silent corruption of any
 * non-ASCII pane output. Reporting where the last whole character ends lets the
 * caller hold the remainder back until its continuation arrives.
 */
function leadLength(byte: number): number {
  // Each range needs its own ceiling: 0xc0, 0xc1, and everything from 0xf5 up
  // begin no character in UTF-8, so they are one opaque byte and not the start
  // of something still to come.
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  return 1;
}

export function completeUtf8Length(bytes: Uint8Array): number {
  // A character is at most four bytes, so the split can only be in the last
  // three; anything earlier is already complete.
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue; // a continuation byte
    // Only a real lead byte can be waiting for more. A pane writing binary or
    // latin-1 emits bytes that begin nothing, and holding one back would stall
    // that pane until it happened to write something else.
    const needed = leadLength(byte);
    return needed > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** Decode one `%output` payload; the connection supplies a pane-aware one. */
export type OutputDecoder = (paneId: string, payload: Uint8Array) => string;

const decodeWhole: OutputDecoder = (_paneId, payload) => decoder.decode(payload);

/**
 * Read `<time> <command number> <flags>`; flags 1 means this client's command.
 *
 * Undefined for a line too short to be a guard, which makes it body rather than
 * a boundary. Trailing fields are ignored so a later tmux may add one.
 */
function parseGuard(rest: string): { fromClient: boolean; guard: GuardIdentity } | undefined {
  const [time, number, flags] = rest.split(" ");
  if (time === undefined || number === undefined || flags === undefined) return undefined;
  return { fromClient: flags === "1", guard: { number, time } };
}

function splitArguments(rest: string, limit: number): readonly string[] {
  const parts: string[] = [];
  let remainder = rest;
  while (parts.length < limit - 1) {
    const space = remainder.indexOf(" ");
    if (space === -1) break;
    parts.push(remainder.slice(0, space));
    remainder = remainder.slice(space + 1);
  }
  if (remainder.length > 0 || parts.length > 0) parts.push(remainder);
  return parts;
}

/**
 * Parse one control-mode line.
 *
 * Returns undefined for a line that is not a notification, which is the body of
 * a command's response block.
 */
export function parseControlLine(
  line: Uint8Array,
  decodeOutput: OutputDecoder = decodeWhole,
): ControlBlockBoundary | TmuxEvent | undefined {
  if (line.length === 0 || line[0] !== 0x25) return undefined;
  const space = line.indexOf(0x20);
  const name = decoder.decode(line.subarray(1, space === -1 ? line.length : space));
  const rest = space === -1 ? "" : decoder.decode(line.subarray(space + 1));

  switch (name) {
    case "begin": {
      const parsed = parseGuard(rest);
      if (parsed === undefined) break;
      return { fromClient: parsed.fromClient, guard: parsed.guard, kind: "block-begin" };
    }
    case "end":
    case "error": {
      const parsed = parseGuard(rest);
      if (parsed === undefined) break;
      return {
        failed: name === "error",
        fromClient: parsed.fromClient,
        guard: parsed.guard,
        kind: "block-end",
      };
    }
    case "output": {
      // The payload is raw bytes, so it is sliced before decoding.
      const payloadStart = line.indexOf(0x20, space + 1);
      if (space === -1 || payloadStart === -1) break;
      const paneId = decoder.decode(line.subarray(space + 1, payloadStart));
      return {
        data: decodeOutput(paneId, unescapeOutput(line.subarray(payloadStart + 1))),
        kind: "output",
        paneId,
      };
    }
    case "extended-output": {
      const [paneId, age, marker] = splitArguments(rest, 4);
      const offset = line.indexOf(0x20, space + 1);
      const ageEnd = offset === -1 ? -1 : line.indexOf(0x20, offset + 1);
      const markerEnd = ageEnd === -1 ? -1 : line.indexOf(0x20, ageEnd + 1);
      if (paneId === undefined || age === undefined || marker !== ":" || markerEnd === -1) break;
      return {
        age: Number(age),
        data: decodeOutput(paneId, unescapeOutput(line.subarray(markerEnd + 1))),
        kind: "extended-output",
        paneId,
      };
    }
    case "window-add":
    case "window-close":
    case "unlinked-window-add":
    case "unlinked-window-close":
      return { kind: name, windowId: rest };
    case "window-renamed":
    case "unlinked-window-renamed": {
      const [windowId, windowName] = splitArguments(rest, 2);
      if (windowId === undefined || windowName === undefined) break;
      return { kind: name, name: windowName, windowId };
    }
    case "window-pane-changed": {
      const [windowId, paneId] = splitArguments(rest, 2);
      if (windowId === undefined || paneId === undefined) break;
      return { kind: name, paneId, windowId };
    }
    case "layout-change": {
      const [windowId, layout, visibleLayout, flags] = splitArguments(rest, 4);
      if (windowId === undefined || layout === undefined) break;
      return {
        flags: flags ?? "",
        kind: name,
        layout,
        visibleLayout: visibleLayout ?? layout,
        windowId,
      };
    }
    case "session-changed":
    case "session-renamed": {
      const [sessionId, sessionName] = splitArguments(rest, 2);
      if (sessionId === undefined || sessionName === undefined) break;
      return { kind: name, name: sessionName, sessionId };
    }
    case "sessions-changed":
      return { kind: name };
    case "session-window-changed": {
      const [sessionId, windowId] = splitArguments(rest, 2);
      if (sessionId === undefined || windowId === undefined) break;
      return { kind: name, sessionId, windowId };
    }
    case "client-session-changed": {
      const [client, sessionId, sessionName] = splitArguments(rest, 3);
      if (client === undefined || sessionId === undefined || sessionName === undefined) break;
      return { client, kind: name, name: sessionName, sessionId };
    }
    case "client-detached":
      return { client: rest, kind: name };
    case "pane-mode-changed":
      return { kind: name, paneId: rest };
    case "paste-buffer-changed":
    case "paste-buffer-deleted":
      return { buffer: rest, kind: name };
    case "continue":
    case "pause":
      return { kind: name, paneId: rest };
    case "config-error":
    case "message":
      return { kind: name, message: rest };
    case "exit":
      return { kind: "exit", reason: rest.length === 0 ? undefined : rest };
    default:
      break;
  }
  return { args: splitArguments(rest, Number.MAX_SAFE_INTEGER), kind: "unknown", name };
}
