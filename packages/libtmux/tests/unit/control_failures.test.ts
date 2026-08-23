/**
 * What a caller is handed when the pipe to tmux breaks.
 *
 * Node reports a broken pipe as its own `Error`, with a `code` and nothing
 * else. Handed on unchanged it is invisible to `catch (error) { if (error
 * instanceof LibTmuxException) }`, and it carries no `delivery` — which is the
 * one fact a caller needs about a command that was written and never answered.
 */

import { describe, expect, test } from "bun:test";

import { transportFailure } from "../../src/_internal/control/connection.js";
import { LibTmuxException, TmuxTransportError } from "../../src/exc.js";

function nodeError(code: string): Error {
  return Object.assign(new Error(`${code}: broken pipe, send`), { code });
}

describe("a broken connection in this package's terms", () => {
  test("names a Node pipe error without losing it", () => {
    const failure = transportFailure(nodeError("EPIPE"));

    expect(failure).toBeInstanceOf(TmuxTransportError);
    expect(failure).toBeInstanceOf(LibTmuxException);
    expect(failure.kind).toBe("pipe");
    // Written and never answered: tmux may have run it, so retrying a
    // kill-session is how one becomes two.
    expect(failure.delivery).toBe("indeterminate");
    // The code says which pipe failure it was; the cause keeps the original.
    expect(failure.message).toContain("EPIPE");
    expect(failure.cause).toBeInstanceOf(Error);
  });

  test("names an error carrying no code", () => {
    const failure = transportFailure(new Error("something else"));

    expect(failure).toBeInstanceOf(TmuxTransportError);
    expect(failure.message).not.toContain("undefined");
    expect(failure.delivery).toBe("indeterminate");
  });

  test("passes a transport error through rather than wrapping it twice", () => {
    // The connection raises its own for an unterminated line and an exit, and
    // those already say what happened and how far the command got.
    const original = new TmuxTransportError("tmux control mode sent an unterminated line", {
      delivery: "indeterminate",
      kind: "protocol",
    });

    expect(transportFailure(original)).toBe(original);
    expect(transportFailure(original).kind).toBe("protocol");
  });
});
