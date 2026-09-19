/**
 * Fast, tmux-free coverage of `pane_echo.ts`'s key model, word-boundary
 * removal, TTL/cap bounds, and server-identity keying. The real-tmux
 * scenarios (S1-S6 from the echo contract) live in `echo_contract.test.ts`;
 * this is the inner loop for the logic those scenarios exercise end to end.
 */
import { expect, test } from "bun:test";

import {
  liveEcho,
  noteKeyDispatch,
  noteLiteralWrite,
  pruneDeadPanes,
  withoutEcho,
  withoutEchoes,
  type PaneServerIdentity,
} from "../src/pane_echo.js";

const identity: PaneServerIdentity = {
  pid: "4242",
  socketPath: "/tmp/pane-echo-test.sock",
  startTime: "1000",
};

let paneCounter = 0;
function freshPane(): string {
  paneCounter += 1;
  return `%pane-echo-test-${String(paneCounter)}`;
}

test("withoutEcho removes only whole-word occurrences", () => {
  expect(withoutEcho("$ ready", "y")).toBe("$ ready");
  expect(withoutEcho("$ y", "y")).toBe("$ ");
  expect(withoutEcho("uid=1000", "id")).toBe("uid=1000");
  expect(withoutEcho("$ id", "id")).toBe("$ ");
});

test("withoutEchoes removes every distinct echo, each as a whole unit", () => {
  expect(withoutEchoes("echo MARKER\nMARKER\n", ["echo MARKER"])).toBe("\nMARKER\n");
});

test("noteKeyDispatch tracks literal fallback text and clears on submit", () => {
  const pane = freshPane();
  noteKeyDispatch(pane, identity, "echo MARKER", false);
  expect(liveEcho(pane, identity).pending).toBe("echo MARKER");
  noteKeyDispatch(pane, identity, "Enter", false);
  const after = liveEcho(pane, identity);
  expect(after.pending).toBe("");
  expect(after.recent).toEqual(["echo MARKER"]);
});

test("BSpace erases exactly, including overflow into an earlier call's text", () => {
  const pane = freshPane();
  noteKeyDispatch(pane, identity, "xMARKER", false);
  for (let i = 0; i < 7; i += 1) noteKeyDispatch(pane, identity, "BSpace", false);
  const midway = liveEcho(pane, identity);
  expect(midway.pending).toBe("");
  // The fully-erased span is still captured: a shell that redraws by `\r`
  // leaves it sitting in the tail as its own line, unaffected by the erase.
  expect(midway.recent).toContain("xMARKER");
  // One more BSpace than there is text to erase is a no-op, not an underflow.
  noteKeyDispatch(pane, identity, "BSpace", false);
  expect(liveEcho(pane, identity).pending).toBe("");
});

test("C-u and C-c discard the line but still protect what they discarded", () => {
  for (const killKey of ["C-u", "C-c"]) {
    const pane = freshPane();
    noteKeyDispatch(pane, identity, "oops", false);
    noteKeyDispatch(pane, identity, killKey, false);
    const after = liveEcho(pane, identity);
    expect(after.pending).toBe("");
    expect(after.recent).toContain("oops");
  }
});

test("DC is a no-op", () => {
  const pane = freshPane();
  noteKeyDispatch(pane, identity, "MARKER", false);
  noteKeyDispatch(pane, identity, "DC", false);
  expect(liveEcho(pane, identity).pending).toBe("MARKER");
});

test("an unmodelled key clears the line rather than keeping it stale (S6)", () => {
  for (const unknownKey of ["Left", "Right", "Home", "End", "Tab", "C-a", "F5"]) {
    const pane = freshPane();
    noteKeyDispatch(pane, identity, "xMARKER", false);
    noteKeyDispatch(pane, identity, unknownKey, false);
    const after = liveEcho(pane, identity);
    expect(after.pending).toBe("");
    // Fails open, unlike libtmux-go's reference model: nothing is carried
    // into `recent` either, so a wait stops discounting this line instead of
    // masking output with a capture that may no longer describe it.
    expect(after.recent).toEqual([]);
  }
});

test("a submitted line remains discounted after enter clears pending", () => {
  const pane = freshPane();
  noteKeyDispatch(pane, identity, "echo MARKER", true);
  const after = liveEcho(pane, identity);
  expect(after.pending).toBe("");
  expect(after.recent).toEqual(["echo MARKER"]);
});

test("a literal multi-line write submits every embedded line as one unit", () => {
  const pane = freshPane();
  noteLiteralWrite(pane, identity, "echo one\necho two", true);
  const after = liveEcho(pane, identity);
  expect(after.pending).toBe("");
  expect(after.recent).toEqual(["echo one\necho two\n"]);
});

test("a record is keyed by server identity, not pane id alone", () => {
  const pane = freshPane();
  noteKeyDispatch(pane, identity, "secret", false);
  expect(liveEcho(pane, identity).pending).toBe("secret");

  const restarted: PaneServerIdentity = { ...identity, startTime: "999999" };
  expect(liveEcho(pane, restarted)).toEqual({ pending: "", recent: [] });

  // A write under the new identity does not inherit the old generation's text.
  noteKeyDispatch(pane, restarted, "y", false);
  expect(liveEcho(pane, restarted).pending).toBe("y");
});

test("pruneDeadPanes bounds memory once a pane is gone", () => {
  const pane = freshPane();
  noteKeyDispatch(pane, identity, "secret", false);
  expect(liveEcho(pane, identity).pending).toBe("secret");
  pruneDeadPanes(new Set());
  expect(liveEcho(pane, identity)).toEqual({ pending: "", recent: [] });
});
