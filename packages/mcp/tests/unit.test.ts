import { describe, expect, test } from "bun:test";

import { Server } from "libtmux/server";

import { readCallerEnvironment } from "../src/caller.js";
import { describeUnreachable } from "../src/context.js";
import { buildInstructions, instructionsBudget } from "../src/instructions.js";
import { frame, randomId, withoutForeignFraming } from "../src/command.js";
import { PaneTail } from "../src/live.js";
import { effectiveWaitMs, resolvePolicy, tierAllows } from "../src/policy.js";
import { describeStartup } from "../src/startup.js";
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
  });

  test("offers the default tier when nobody chose one", () => {
    expect(resolvePolicy({}).safety).toBe("mutating");
  });

  test("reads a tier by name, including the way readonly is usually mistyped", () => {
    expect(resolvePolicy({ LIBTMUX_SAFETY: "readonly" }).safety).toBe("readonly");
    expect(resolvePolicy({ LIBTMUX_SAFETY: "read-only" }).safety).toBe("readonly");
    expect(resolvePolicy({ LIBTMUX_SAFETY: " Destructive " }).safety).toBe("destructive");
  });

  test("narrows to readonly on a tier it does not recognise, rather than widening", () => {
    // Falling back is right — the variable is read from wherever the process
    // was started, and refusing to launch hides the reason. Falling back
    // *upward* is not: it hands an agent the tools an operator was trying to
    // withhold, and the mistake looks exactly like a working configuration.
    for (const given of ["read only", "read_only", "ro", "yolo", ""]) {
      expect(resolvePolicy({ LIBTMUX_SAFETY: given }).safety).toBe("readonly");
    }
  });

  test("orders the safety tiers so a lower one hides a higher one's tools", () => {
    expect(tierAllows("readonly", "mutating")).toBe(false);
    expect(tierAllows("mutating", "readonly")).toBe(true);
    expect(tierAllows("mutating", "destructive")).toBe(false);
    expect(tierAllows("destructive", "destructive")).toBe(true);
  });
});

describe("startup line", () => {
  test("names the tier in force, which is the setting most worth mistyping", () => {
    const line = describeStartup({
      caller: { paneId: undefined, serverPid: undefined, socketPath: undefined },
      policy: resolvePolicy({ LIBTMUX_SAFETY: "readonly" }),
      server: new Server({ socketName: "agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("readonly");
    expect(line).toContain("1.2.3");
  });

  test("names the socket, so two servers in one log can be told apart", () => {
    const line = describeStartup({
      caller: { paneId: undefined, serverPid: undefined, socketPath: undefined },
      policy: resolvePolicy({}),
      server: new Server({ socketPath: "/tmp/libtmux-rs-dev/agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("/tmp/libtmux-rs-dev/agents");
  });

  test("says when an allowlist has narrowed the surface further than the tier", () => {
    const line = describeStartup({
      caller: { paneId: undefined, serverPid: undefined, socketPath: undefined },
      policy: resolvePolicy({ LIBTMUX_MCP_TOOLS: "list_panes, capture_pane" }),
      server: new Server({ socketName: "agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("2");
  });

  test("names the caller's pane, since the tools that would destroy it refuse", () => {
    const line = describeStartup({
      caller: { paneId: "%7", serverPid: "4242", socketPath: "/tmp/x" },
      policy: resolvePolicy({}),
      server: new Server({ socketName: "agents" }),
      version: "1.2.3",
    });
    expect(line).toContain("%7");
  });

  test("is one line, because a startup banner nobody can scan is not read", () => {
    const line = describeStartup({
      caller: { paneId: "%7", serverPid: "4242", socketPath: "/tmp/x" },
      policy: resolvePolicy({ LIBTMUX_MCP_TOOLS: "list_panes" }),
      server: new Server({ socketPath: "/tmp/libtmux-rs-dev/agents" }),
      version: "1.2.3",
    });
    expect(line).not.toContain("\n");
  });
});

describe("tool allowlist", () => {
  test("reads a list, and treats a blank value as no decision", () => {
    expect(resolvePolicy({ LIBTMUX_MCP_TOOLS: "list_panes, capture_pane" }).tools).toEqual(
      new Set(["list_panes", "capture_pane"]),
    );
    // Blank means "I did not decide", not "offer nothing" — the second is a
    // puzzle rather than a policy.
    expect(resolvePolicy({ LIBTMUX_MCP_TOOLS: "" }).tools).toBeUndefined();
    expect(resolvePolicy({ LIBTMUX_MCP_TOOLS: " , " }).tools).toBeUndefined();
    expect(resolvePolicy({}).tools).toBeUndefined();
  });
});

describe("unreachable server", () => {
  test("names the variable an operator set, because the agent did not set it", () => {
    const byPath = describeUnreachable(
      new Server({ socketPath: "/tmp/ltx-gone" }),
      "cannot reach tmux: no server running on /tmp/ltx-gone",
    );
    expect(byPath).toContain("LIBTMUX_SOCKET_PATH=/tmp/ltx-gone");
    // The recovery matters more than the reason: an agent told only that
    // something failed reports "unavailable" and stops, which is what one did.
    expect(byPath).toContain("new_session");
    expect(byPath).toContain("report it rather than retrying");

    expect(describeUnreachable(new Server({ socketName: "agent" }), "cannot reach tmux")).toContain(
      "LIBTMUX_SOCKET_NAME=agent",
    );
    // Nothing set at all, so there is no knob to send anyone to. The wording
    // covers the executable as well as the socket now, since a bad binary and
    // a bad socket reach here identically.
    expect(describeUnreachable(new Server(), "cannot reach tmux")).toContain("nothing configured");
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

describe("command framing", () => {
  test("keeps a multiline command out of the shell history too", () => {
    // The leading space is the whole mechanism, and a shell records a
    // multiline buffer as one entry — so skipping it there put the shape most
    // likely to carry a secret, a pasted block, into the history file.
    expect(frame("echo one", "ltxabc", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\necho two", "ltxabc", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\recho two", "ltxabc", true).startsWith(" ")).toBe(true);
  });

  test("leaves the space off when the caller did not ask for suppression", () => {
    expect(frame("echo one", "ltxabc", false).startsWith(" ")).toBe(false);
    expect(frame("echo one\necho two", "ltxabc", false).startsWith(" ")).toBe(false);
  });
});

describe("concurrent framing", () => {
  // The stream one caller sees when a second caller types into the same pane
  // partway through: the second command's echo, its markers, and its output.
  const contaminated = [
    "AAA-start",
    ` m=ltxbbb222; printf '%s\\n' "\${m}_S"; ( echo BBB-secret ); s=$?`,
    "ltxbbb222_S",
    "BBB-secret",
    "ltxbbb222_E 0",
    "AAA-end",
  ].join("\n");

  test("keeps another caller's command and output out of this one's", () => {
    const cleaned = withoutForeignFraming(contaminated, "ltxaaa111");
    expect(cleaned.text).toBe("AAA-start\nAAA-end");
    expect(cleaned.text).not.toContain("BBB-secret");
    expect(cleaned.text).not.toContain("ltxbbb222");
    // Removed, and said so: what was cleaned is still evidence that the pane
    // had another writer, so output with no marker may be theirs too.
    expect(cleaned.foreignOutputSuspected).toBe(true);
  });

  test("leaves this caller's own output alone and claims nothing", () => {
    const cleaned = withoutForeignFraming("one\ntwo\nthree", "ltxaaa111");
    expect(cleaned.text).toBe("one\ntwo\nthree");
    expect(cleaned.foreignOutputSuspected).toBe(false);
  });

  test("reports what it cannot bracket rather than guessing", () => {
    // A background job is a genuinely concurrent writer: its start marker
    // lands inside this body with no end marker to bracket it. Dropping to
    // the end would take OURS-end, which is real output, so the orphaned line
    // stays and the result says another writer was here.
    const unterminated = ["OURS-start", "ltxdeadbeef01_S", "FOREIGN-SECRET-42", "OURS-end"].join(
      "\n",
    );
    const cleaned = withoutForeignFraming(unterminated, "ltxaaa111");
    expect(cleaned.text).toContain("OURS-start");
    expect(cleaned.text).toContain("OURS-end");
    expect(cleaned.text).not.toContain("ltxdeadbeef01");
    // The honest part: the secret is still there, and the caller is told so
    // rather than handed it silently or handed a hole silently.
    expect(cleaned.foreignOutputSuspected).toBe(true);
  });
});

describe("framing ids", () => {
  test("the scrubber recognises the ids this server actually mints", () => {
    // MARKER matches lowercase hex, which is what randomId emits today, and
    // nothing else says the two are coupled. Widen the alphabet and the
    // scrubber stops recognising foreign framing — it would report clean
    // output and keep the other caller's, a disclosure failure with no
    // symptom. This is the only thing that would go red.
    for (let index = 0; index < 200; index += 1) {
      const minted = `ltx${randomId()}`;
      const seen = withoutForeignFraming(`ours\n${minted}_S\ntheirs`, "ltxnottheone");
      expect(seen.foreignOutputSuspected, `${minted} was not recognised as framing`).toBe(true);
    }
  });
});

describe("tail lifetime", () => {
  test("a tail reports going unread, and reading resets it", async () => {
    // Reading is what keeps a tail alive. A pane writing into one nobody is
    // watching is not a reason to hold its connection open — which is what
    // used to happen, because nothing ever removed a tail and so the close
    // path's own guard made it unreachable for any observed session.
    const tail = new PaneTail("%1");
    expect(tail.idleMs(Date.now())).toBeLessThan(50);
    expect(tail.idleMs(Date.now() + 60_000)).toBeGreaterThanOrEqual(60_000);

    tail.append("output nobody asked for");
    // Still idle: the pane wrote, nothing read.
    expect(tail.idleMs(Date.now() + 60_000)).toBeGreaterThanOrEqual(60_000);

    tail.read(undefined);
    expect(tail.idleMs(Date.now())).toBeLessThan(50);
  });
});

describe("unreachable guidance", () => {
  test("names the executable when that is what was configured", () => {
    // A bad binary and a bad socket both surface as "cannot reach tmux". This
    // text is the only channel to the human who can fix either, so naming the
    // healthy one sends them to check something that is fine.
    const said = describeUnreachable(
      new Server({ socketName: "fine", tmuxBin: "/nonexistent/tmux" }),
      "cannot reach tmux: could not run /nonexistent/tmux (ENOENT)",
    );
    expect(said).toContain("LIBTMUX_TMUX_BIN=/nonexistent/tmux");
    expect(said).toContain("LIBTMUX_SOCKET_NAME=fine");
  });

  test("says nothing about an executable nobody chose", () => {
    // The quiet half: naming a default nobody set is noise, and would make the
    // line say something was configured when it was not.
    const said = describeUnreachable(
      new Server({ socketName: "fine" }),
      "cannot reach tmux: error connecting to /tmp/tmux-1000/fine",
    );
    expect(said).not.toContain("LIBTMUX_TMUX_BIN");
    expect(said).toContain("LIBTMUX_SOCKET_NAME=fine");
  });
});
