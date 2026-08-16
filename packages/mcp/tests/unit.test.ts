import { describe, expect, test } from "bun:test";

import { readCallerEnvironment } from "../src/caller.js";
import { buildInstructions, instructionsBudget } from "../src/instructions.js";
import { PaneTail } from "../src/live.js";
import { effectiveWaitMs, resolvePolicy, tierAllows } from "../src/policy.js";
import { fail, ok, renderOutput, tailLines } from "../src/results.js";
import { TextFilter } from "../src/text.js";
import { paneContentUri } from "../src/uris.js";

const readableText = (raw: string): string => new TextFilter().push(raw);

describe("text filter", () => {
  test("removes the escapes a shell puts between characters", () => {
    // zsh syntax highlighting colours each character, which is what makes a
    // pattern match against the raw stream fail on a coloured prompt.
    const coloured = "[32mh[32me[32ml[32ml[32mo[39m";
    expect(readableText(coloured)).toBe("hello");
  });

  test("keeps a sequence split across two chunks from leaking", () => {
    const filter = new TextFilter();
    // tmux splits notifications wherever it likes, so a stateless filter would
    // emit the tail of a sequence as text.
    expect(filter.push("a[3")).toBe("a");
    expect(filter.push("2mb")).toBe("b");
  });

  test("reads a line rewritten in place as a later line", () => {
    expect(readableText("50%\r100%\r\ndone\n")).toBe("50%\n100%\ndone\n");
  });

  test("applies backspace so a re-edited line is not reported twice", () => {
    expect(readableText("cat\b\bar")).toBe("car");
  });

  test("drops OSC title sequences whichever terminator they use", () => {
    expect(readableText("]0;titletext")).toBe("text");
    expect(readableText("]0;title\\text")).toBe("text");
  });

  test("leaves ordinary text alone", () => {
    expect(readableText("plain output\nsecond line\n")).toBe("plain output\nsecond line\n");
  });
});

describe("pane tail", () => {
  test("returns only what arrived after the cursor", () => {
    const tail = new PaneTail("%1");
    tail.append("first\n");
    const mark = tail.cursor;
    tail.append("second\n");
    expect(tail.read(mark).text).toBe("second\n");
  });

  test("reports what fell out of the buffer rather than losing it silently", () => {
    const tail = new PaneTail("%1", 8);
    tail.append("0123456789abcdef");
    const seen = tail.read(0);
    expect(seen.missedBytes).toBe(8);
    expect(seen.text).toBe("89abcdef");
  });

  test("wakes a waiter when output arrives", async () => {
    const tail = new PaneTail("%1");
    const waiting = tail.changed(5_000);
    tail.append("something\n");
    await waiting;
    expect(tail.read(0).text).toBe("something\n");
  });

  test("gives up on a waiter as soon as its caller is cancelled", async () => {
    // Without this a cancelled wait keeps its loop and its connection for the
    // rest of a deadline nobody is waiting on.
    const tail = new PaneTail("%1");
    const controller = new AbortController();
    const started = Date.now();
    const waiting = tail.changed(30_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("gives up on a waiter at its deadline", async () => {
    const tail = new PaneTail("%1");
    const started = Date.now();
    await tail.changed(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe("policy", () => {
  test("clamps a blocking wait to the ceiling and reports the ceiling", () => {
    const policy = resolvePolicy({});
    expect(effectiveWaitMs(policy, 999_999_999, false)).toBe(policy.blockingWaitMaxMs);
  });

  test("lets a task wait far longer than a blocking one", () => {
    const policy = resolvePolicy({});
    expect(effectiveWaitMs(policy, 300_000, true)).toBe(300_000);
    expect(effectiveWaitMs(policy, 300_000, false)).toBe(policy.blockingWaitMaxMs);
  });

  test("keeps an operator override inside bounds that leave it a ceiling", () => {
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "1" }).blockingWaitMaxMs).toBe(1_000);
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "99999999" }).blockingWaitMaxMs).toBe(120_000);
  });

  test("falls back rather than refusing to start on an unparseable value", () => {
    // An MCP server that refuses to start is one whose message nobody reads.
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "soon" }).blockingWaitMaxMs).toBe(30_000);
    expect(resolvePolicy({ LIBTMUX_SAFETY: "yolo" }).safety).toBe("mutating");
  });

  test("orders the safety tiers so a lower one hides a higher one's tools", () => {
    expect(tierAllows("readonly", "mutating")).toBe(false);
    expect(tierAllows("mutating", "readonly")).toBe(true);
    expect(tierAllows("mutating", "destructive")).toBe(false);
    expect(tierAllows("destructive", "destructive")).toBe(true);
  });
});

describe("results", () => {
  test("keeps the tail, because a verdict is at the end", () => {
    const trimmed = tailLines(["a", "b", "c", "d"], 2);
    expect(trimmed.lines).toEqual(["c", "d"]);
    expect(trimmed.droppedLines).toBe(2);
    expect(renderOutput(trimmed)).toContain("2 earlier lines omitted");
  });

  test("carries no structuredContent on failure", () => {
    // A client validates structuredContent against the tool's outputSchema even
    // for an error, so a failure that carried its own shape would be rejected
    // as a protocol violation and the model would never read the reason.
    const failure = fail({ hint: "try %1", reason: "No pane %9" });
    expect(failure.isError).toBe(true);
    expect(failure).not.toHaveProperty("structuredContent");
    expect(failure.content[0]).toMatchObject({ text: expect.stringContaining("try %1") });
  });

  test("carries both shapes on success", () => {
    const result = ok({ value: 1 }, "one");
    expect(result.structuredContent).toEqual({ value: 1 });
    expect(result.content[0]).toMatchObject({ text: "one" });
  });
});

describe("caller environment", () => {
  test("reads the pane from TMUX_PANE and the daemon from TMUX", () => {
    const caller = readCallerEnvironment({
      TMUX: "/tmp/tmux-1000/default,48188,10",
      TMUX_PANE: "%7",
    });
    expect(caller).toEqual({
      paneId: "%7",
      serverPid: "48188",
      socketPath: "/tmp/tmux-1000/default",
    });
  });

  test("reports nothing when the process is not inside tmux", () => {
    expect(readCallerEnvironment({}).paneId).toBeUndefined();
  });

  test("takes the pane from TMUX_PANE even with TMUX absent", () => {
    // The pane is authoritative: TMUX's session index goes stale when a pane
    // moves between sessions, and TMUX_PANE does not.
    expect(readCallerEnvironment({ TMUX_PANE: "%3" }).paneId).toBe("%3");
  });

  test("finds the pid when the socket path itself contains a comma", () => {
    // tmux writes "path,pid,session", so the pid is the second field from the
    // right however many commas the path holds. Reading left to right hands
    // back a fragment of the path as the daemon pid.
    const caller = readCallerEnvironment({ TMUX: "/tmp/run, root/sock,48188,0" });
    expect(caller.serverPid).toBe("48188");
    expect(caller.socketPath).toBe("/tmp/run, root/sock");
  });
});

describe("instructions", () => {
  test("fit the budget with room for the caller context", () => {
    const { limit, used } = instructionsBudget();
    expect(used).toBeLessThan(limit);
  });

  test("name the caller's pane when there is one", () => {
    const text = buildInstructions(resolvePolicy({}), {
      paneId: "%4",
      serverPid: "1",
      socketPath: "/s",
    });
    expect(text).toContain("%4");
    expect(text).toContain("whoami");
  });

  test("say nothing about a pane when the server runs outside tmux", () => {
    const text = buildInstructions(resolvePolicy({}), {
      paneId: undefined,
      serverPid: undefined,
      socketPath: undefined,
    });
    expect(text).not.toContain("running inside tmux pane");
  });

  test("state the active safety tier, since it decides what is listed", () => {
    expect(buildInstructions(resolvePolicy({ LIBTMUX_SAFETY: "readonly" }))).toContain(
      "Safety: readonly",
    );
  });
});

describe("uris", () => {
  test("escape a pane id so its % does not read as an escape", () => {
    expect(paneContentUri("%1")).toBe("tmux://panes/%251/content");
  });
});
