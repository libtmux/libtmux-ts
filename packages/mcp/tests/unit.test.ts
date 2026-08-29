import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import type { ConnectedServer, TmuxEvent, TmuxEventStream } from "libtmux";
import { Server } from "libtmux/server";

import { readCallerEnvironment } from "../src/caller.js";
import { describeUnreachable } from "../src/context.js";
import { buildInstructions, instructionsBudget } from "../src/instructions.js";
import { frame, randomId, withoutForeignFraming } from "../src/command.js";
import { LiveHub } from "../src/live.js";
import { PaneTail } from "../src/pane_tail.js";
import { effectiveWaitMs, MAX_RESULT_BYTES, resolvePolicy, tierAllows } from "../src/policy.js";
import { describeStartup } from "../src/startup.js";
import { fail, ok, renderOutput, tailLines } from "../src/results.js";
import { TextFilter } from "../src/text.js";
import { paneContentUri } from "../src/uris.js";

const readableText = (raw: string): string => new TextFilter().push(raw);

class FakeEventStream {
  readonly #events: TmuxEvent[] = [];
  #ended = false;
  #wake: (() => void) | undefined;
  dropped = 0;

  emit(event: TmuxEvent): void {
    this.#events.push(event);
    this.#wake?.();
  }

  finish(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *events(): AsyncGenerator<TmuxEvent> {
    for (;;) {
      const event = this.#events.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.#ended) return;
      // eslint-disable-next-line no-await-in-loop -- one wake per drained fake queue.
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }

  stream(): TmuxEventStream {
    return {
      [Symbol.asyncDispose]: async () => undefined,
      [Symbol.asyncIterator]: () => this.events(),
      close: async () => {
        this.finish();
      },
      dropped: this.dropped,
      find: async () => undefined,
      ready: async () => undefined,
    } as TmuxEventStream;
  }
}

function fakeConnection(events: FakeEventStream, closed: { count: number }): ConnectedServer {
  const stream = events.stream();
  Object.defineProperty(stream, "dropped", { get: () => events.dropped });
  return {
    close: async () => {
      closed.count += 1;
      events.finish();
    },
    subscribe: () => stream,
  } as ConnectedServer;
}

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

  test("removes a whole Unicode code point on backspace", () => {
    expect(readableText("🙂\b")).toBe("");
  });

  test("renders a correction that crosses notification chunks", () => {
    const filter = new TextFilter();
    expect(filter.push("cat")).toBe("cat");
    expect(filter.push("\b\bar")).toBe("\ncar");
  });

  test("bounds correction state for a newline-free stream", () => {
    const filter = new TextFilter(16);
    filter.push("x".repeat(2 * 1024 * 1024));

    expect(filter.push("\b")).toBe(`\n${"x".repeat(15)}`);
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
    const start = tail.cursor;
    tail.append("0123456789abcdef");
    const seen = tail.read(start);
    expect(seen.missedBytes).toBe(8);
    expect(seen.text).toBe("89abcdef");
  });

  test("keeps correction state inside its retained byte limit", () => {
    const tail = new PaneTail("%1", 4);
    tail.append("abcdef");
    tail.append("\b");

    expect(tail.read(undefined).text).toBe("\ncde");
  });

  test("counts cursors and retention in UTF-8 bytes", () => {
    const tail = new PaneTail("%1", 7);
    const start = tail.cursor;
    tail.append("你🙂ab");

    expect(tail.cursor).toEndWith(".9");
    expect(tail.read(start)).toEqual({ cursor: tail.cursor, missedBytes: 3, text: "🙂ab" });
  });

  test("round-trips a byte cursor across multibyte output", () => {
    const tail = new PaneTail("%1");
    tail.append("你");
    const mark = tail.cursor;
    tail.append("🙂");

    expect(mark).toEndWith(".3");
    expect(tail.read(mark).text).toBe("🙂");
  });

  test("does not decode from the middle of a multibyte character", () => {
    const tail = new PaneTail("%1");
    const start = tail.cursor;
    tail.append("🙂x");
    const middle = start.replace(/\.0$/u, ".1");

    expect(tail.read(middle)).toEqual({ cursor: tail.cursor, missedBytes: 3, text: "x" });
  });

  test("refuses a cursor from another tail even when its offset fits", () => {
    const first = new PaneTail("%1");
    first.append("old");
    const second = new PaneTail("%1");
    second.append("new-data");

    expect(() => second.read(first.cursor)).toThrow("different pane tail");
  });

  test("wakes a waiter when output arrives", async () => {
    const tail = new PaneTail("%1");
    const waiting = tail.changed(5_000);
    tail.append("something\n");
    await waiting;
    expect(tail.read(undefined).text).toBe("something\n");
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

  test("removes an abort listener when a wait times out", async () => {
    const tail = new PaneTail("%1");
    const controller = new AbortController();

    expect(await tail.changed(5, controller.signal)).toBe("timed_out");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("settles immediately when its caller is already cancelled", async () => {
    const tail = new PaneTail("%1");
    const controller = new AbortController();
    controller.abort();

    expect(await tail.changed(30, controller.signal)).toBe("cancelled");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("closes and wakes every in-flight waiter", async () => {
    const tail = new PaneTail("%1");
    const waiting = tail.changed(30_000);

    tail.close("connection_lost");

    expect(await waiting).toBe("closed");
    expect(tail.endReason).toBe("connection_lost");
  });
});

describe("live hub", () => {
  test("closes tails when the source drops an event", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const connected = fakeConnection(events, closed);
    const hub = new LiveHub({ connect: async () => connected } as Server);
    const tail = await hub.tail("$1", "%1");
    expect(tail).toBeDefined();
    const waiting = tail?.changed(30_000);

    events.dropped = 1;
    events.emit({ data: "after-gap", kind: "output", paneId: "%1" } as TmuxEvent);

    expect(await waiting).toBe("closed");
    expect(tail?.endReason).toBe("events_dropped");
    expect(tail?.read(undefined).text).toBe("");
    await hub.close();
  });

  test("closes and wakes tails when their connection ends", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () => fakeConnection(events, { count: 0 }),
    } as Server);
    const tail = await hub.tail("$1", "%1");
    const waiting = tail?.changed(30_000);

    events.finish();

    expect(await waiting).toBe("closed");
    expect(tail?.endReason).toBe("connection_lost");
    await hub.close();
  });

  test("closes a connection that opens after the hub closed", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const connected = fakeConnection(events, closed);
    let resolve!: (value: ConnectedServer) => void;
    const opening = new Promise<ConnectedServer>((done) => {
      resolve = done;
    });
    const hub = new LiveHub({ connect: () => opening } as Server);
    const acquiring = hub.tail("$1", "%1");

    let closeSettled = false;
    const closing = hub.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolve(connected);

    await closing;
    expect(await acquiring).toBeUndefined();
    expect(closed.count).toBe(1);
  });

  test("does not re-arm listener expiry after the hub closed", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const hub = new LiveHub({ connect: async () => fakeConnection(events, closed) } as Server, {
      lingerMs: 5,
    });
    const stop = await hub.listen("$1", () => undefined);

    await hub.close();
    const closedAtShutdown = closed.count;
    stop?.();
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(closed.count).toBe(closedAtShutdown);
  });

  test("does not expire a tail while a reader is waiting", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub(
      { connect: async () => fakeConnection(events, { count: 0 }) } as Server,
      { lingerMs: 10 },
    );
    const tail = await hub.tail("$1", "%1");
    const waiting = tail?.changed(5_000);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tail?.endReason).toBeUndefined();
    events.emit({ data: "still-watched", kind: "output", paneId: "%1" } as TmuxEvent);

    expect(await waiting).toBe("changed");
    await hub.close();
  });

  test("re-arms expiry after acquiring an existing tail", async () => {
    const events = new FakeEventStream();
    const closed = { count: 0 };
    const hub = new LiveHub({ connect: async () => fakeConnection(events, closed) } as Server, {
      lingerMs: 15,
    });
    const tail = await hub.tail("$1", "%1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await hub.tail("$1", "%1")).toBe(tail);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(tail?.endReason).toBe("expired");
    expect(closed.count).toBeGreaterThan(0);
    await hub.close();
  });

  test("invalidates tails when pane placement may have changed", async () => {
    const events = new FakeEventStream();
    const hub = new LiveHub({
      connect: async () => fakeConnection(events, { count: 0 }),
    } as Server);
    const tail = await hub.tail("$1", "%1");
    const cursor = tail?.cursor;

    events.emit({ kind: "layout-change" } as TmuxEvent);

    expect(await tail?.changed(5_000)).toBe("closed");
    expect(tail?.endReason).toBe("topology_changed");
    const replacement = await hub.tail("$1", "%1");
    expect(replacement).not.toBe(tail);
    expect(replacement?.cursor).not.toBe(cursor);
    await hub.close();
  });
});

describe("policy", () => {
  test("clamps a blocking wait to the ceiling and reports the ceiling", () => {
    const policy = resolvePolicy({});
    expect(effectiveWaitMs(policy, 999_999_999)).toBe(policy.blockingWaitMaxMs);
  });

  test("defaults a wait to the blocking ceiling", () => {
    const policy = resolvePolicy({});
    expect(effectiveWaitMs(policy, undefined)).toBe(policy.blockingWaitMaxMs);
  });

  test("keeps an operator override inside bounds that leave it a ceiling", () => {
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "1" }).blockingWaitMaxMs).toBe(1_000);
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "99999999" }).blockingWaitMaxMs).toBe(120_000);
  });

  test("falls back rather than refusing to start on an unparseable value", () => {
    // An MCP server that refuses to start is one whose message nobody reads.
    expect(resolvePolicy({ LIBTMUX_MCP_WAIT_MAX_MS: "soon" }).blockingWaitMaxMs).toBe(30_000);
  });

  test("requires an exact positive decimal safe integer", () => {
    for (const given of ["0", "-1", "42junk", "1.5", "1e6", "+42", " 42", "9007199254740992"]) {
      expect(resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: given }).commandTimeoutMs).toBe(
        30_000,
      );
    }
    expect(resolvePolicy({ LIBTMUX_MCP_COMMAND_TIMEOUT_MS: "42" }).commandTimeoutMs).toBe(42);
  });

  test("offers the default tier when nobody chose one", () => {
    expect(resolvePolicy({}).safety).toBe("readonly");
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

  test("returns no lines when none fit the budget", () => {
    expect(tailLines(["a", "b"], 0)).toEqual({ droppedLines: 2, lines: [] });
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

  test("bounds every success and failure text envelope", () => {
    const oversized = "x".repeat(MAX_RESULT_BYTES + 1_000);
    for (const result of [ok({ value: 1 }, oversized), fail({ reason: oversized })]) {
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("expected text content");
      expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES + 256);
      expect(content.text).toContain("bytes omitted by the result ceiling");
    }
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
  const shells = [
    ...new Set(
      ["sh", "bash", "dash", "zsh"].map((name) => Bun.which(name)).filter((path) => path !== null),
    ),
  ];

  function run(
    shell: string,
    source: string,
    input?: string,
  ): { readonly status: number | null; readonly stderr: string; readonly stdout: string } {
    const result = spawnSync(shell, ["-c", source], { encoding: "utf8", input });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  test("keeps a multiline command out of the shell history too", () => {
    // The leading space is the whole mechanism, and a shell records a
    // multiline buffer as one entry — so skipping it there put the shape most
    // likely to carry a secret, a pasted block, into the history file.
    expect(frame("echo one", "ltxready", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\necho two", "ltxready", true).startsWith(" ")).toBe(true);
    expect(frame("echo one\recho two", "ltxready", true).startsWith(" ")).toBe(true);
  });

  test("leaves the space off when the caller did not ask for suppression", () => {
    expect(frame("echo one", "ltxready", false).startsWith(" ")).toBe(false);
    expect(frame("echo one\necho two", "ltxready", false).startsWith(" ")).toBe(false);
  });

  test("encodes multiline commands as one physical input line", () => {
    const command = "cat <<'LTX'\none\n\u2603\nLTX\nprintf 'done\\n'\n";
    for (const shell of shells) {
      const source = frame(command, "ltxready", false);
      expect(source, shell).not.toContain("\n");

      const result = run(shell, source, "ltxabc123def0\n");
      expect(result.status, shell).toBe(0);
      expect(result.stderr, shell).toBe("");
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\none\n\u2603\ndone\nltxabc123def0_E 0\n",
      );
    }
  });

  test("closes the protocol after a command ending in a comment", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("printf 'before\\n' # trailing comment", "ltxready", false),
        "ltxabc123def0\n",
      );
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe("ltxready_R\nltxabc123def0_S\nbefore\nltxabc123def0_E 0\n");
    }
  });

  test("ignores unrelated input while waiting for the marker", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("printf 'own-output\\n'", "ltxready", false),
        "other\nltxabc123def0\n",
      );
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\nown-output\nltxabc123def0_E 0\n",
      );
    }
  });

  test("normalizes carriage-return command text before the shell evaluates it", () => {
    for (const shell of shells) {
      const result = run(
        shell,
        frame("true\r\nprintf 'crlf-ok\\n'\rprintf 'cr-ok\\n'\r", "ltxready", false),
        "ltxabc123def0\n",
      );
      expect(result.status, shell).toBe(0);
      expect(result.stderr, shell).toBe("");
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\ncrlf-ok\ncr-ok\nltxabc123def0_E 0\n",
      );
    }
  });

  test("reports a nonzero command under inherited errexit", () => {
    for (const shell of shells) {
      const source =
        `set -e\n${frame("printf 'before\\n'; false; printf 'SHOULD-NOT-RUN\\n'", "ltxready", false)}\n` +
        `case $- in *e*) printf 'errexit-on\\n';; esac`;
      const result = run(shell, source, "ltxabc123def0\n");
      expect(result.status, shell).toBe(0);
      expect(result.stdout, shell).toBe(
        "ltxready_R\nltxabc123def0_S\nbefore\nltxabc123def0_E 1\nerrexit-on\n",
      );
    }
  });

  test("keeps the marker out of inherited Bash debug state", () => {
    const bash = Bun.which("bash");
    expect(bash).not.toBeNull();
    const command = `for value in "\${BASH_ARGV[@]}"; do printf '%s_E 0\\n' "$value"; done; exit 7`;
    const result = run(
      bash ?? "bash",
      `set -x\nshopt -s extdebug\n${frame(command, "ltxready", false)}\nprintf 'after-xtrace\\n' >/dev/null`,
      "ltxabc123def0\n",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ltxready_R\nltxabc123def0_S\nltxabc123def0_E 7\n");
    expect(result.stderr).toContain("after-xtrace");
    expect(result.stderr).not.toContain("ltxabc123def0");
  });

  test("removes the marker before restoring an inherited Bash DEBUG trap", () => {
    const bash = Bun.which("bash");
    expect(bash).not.toBeNull();
    const trap =
      `trap 'for name in $(compgen -A variable __ltx_); do ` +
      `case "$name" in *_marker) captured="\${!name}";; esac; done' DEBUG`;
    const command = `printf '%s_E 0\n' "\${captured-}"; printf 'after-debug\n'; exit 7`;
    const result = run(
      bash ?? "bash",
      `set -T\n${trap}\n${frame(command, "ltxready", false)}`,
      "ltxabc123def0\n",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "ltxready_R\nltxabc123def0_S\n_E 0\nafter-debug\nltxabc123def0_E 7\n",
    );
  });
});

describe("concurrent framing", () => {
  // The stream one caller sees when a second caller types into the same pane
  // partway through: the second command's echo, its markers, and its output.
  const contaminated = [
    "AAA-start",
    ` __ltx_abc123() { printf '%s\\n' "\${1}_S"; ( set --; echo BBB-secret )`,
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
