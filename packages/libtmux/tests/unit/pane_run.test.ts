import { expect, test } from "bun:test";

import { afterSentKeysEcho, runPane } from "../../src/_internal/operations/pane_run.js";
import { LibTmuxException, WaitTimeout } from "../../src/exc.js";

test("skips the echo of the command before the printed remainder", () => {
  const command = "printf 'ltx-printed-ok\\n' # ltx-decoy-echo";
  const output = `${command}\nltx-printed-ok\n`;

  const after = afterSentKeysEcho(output, command);

  expect(after).toContain("ltx-printed-ok");
  expect(after).not.toContain("ltx-decoy-echo");
});

test("a marker that appears only in the command is not in the remainder", () => {
  const command = "true # ltx-decoy-echo";
  const output = `${command}\n$ `;

  expect(afterSentKeysEcho(output, command)).not.toContain("ltx-decoy-echo");
});

test("an incomplete echo line is not matched", () => {
  const command = "true # ltx-decoy-echo";
  const output = `${command}\r\n% \n❯ t\b${command}`;

  expect(afterSentKeysEcho(output, command)).not.toContain("ltx-decoy-echo");
});

test("output with no echo of the command is left intact once the line completes", () => {
  expect(afterSentKeysEcho("ltx-printed-ok\n", "printf 'ltx-printed-ok\\n'")).toBe(
    "ltx-printed-ok",
  );
});

test("a wrapped echo tail is not treated as printed output", () => {
  const command = "printf 'ltx-printed-ok\\n' # ltx-decoy-echo";
  const output = `${command}\n% \nprintf 'ltx-printed-ok\\n' \n # ltx-decoy-echo\nltx-printed-ok\n`;

  const after = afterSentKeysEcho(output, command);

  expect(after).toContain("ltx-printed-ok");
  expect(after).not.toContain("ltx-decoy-echo");
});

interface FakeEvent {
  readonly kind: string;
  readonly paneId?: string;
  readonly data?: string;
}

/**
 * A pane whose server hands back one scripted event stream.
 *
 * `endAfterEvents` distinguishes a stream that closes on its own from one that
 * stays open until `runPane` disposes it, which is what a real control client
 * does while nothing is printing.
 */
function fakePane(options: {
  readonly events: readonly FakeEvent[];
  readonly endAfterEvents: boolean;
  readonly withSession?: boolean;
}): { readonly pane: unknown; readonly state: { closed: boolean; sent: string[] } } {
  const state = { closed: false, sent: [] as string[] };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const stream = {
    ready: async (): Promise<void> => undefined,
    close: async (): Promise<void> => {
      state.closed = true;
      release();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<FakeEvent> {
      for (const event of options.events) yield event;
      if (!options.endAfterEvents) await gate;
    },
  };

  const pane = {
    id: "%1",
    session: options.withSession === false ? undefined : { id: "$0" },
    server: {
      connect: async (): Promise<unknown> => ({
        subscribe: () => stream,
        [Symbol.asyncDispose]: async (): Promise<void> => undefined,
      }),
    },
    sendKeys: async (command: string): Promise<void> => {
      state.sent.push(command);
    },
  };
  return { pane, state };
}

test("returns the printed remainder once until appears after the echo", async () => {
  const command = "printf 'ltx-printed-ok\\n'";
  const { pane, state } = fakePane({
    endAfterEvents: false,
    events: [
      { data: `${command}\r\n`, kind: "output", paneId: "%1" },
      { data: "ltx-printed-ok\r\n", kind: "output", paneId: "%1" },
    ],
  });

  const output = await runPane(pane as Parameters<typeof runPane>[0], command, {
    until: "ltx-printed-ok",
  });

  expect(output).toContain("ltx-printed-ok");
  expect(state.sent).toEqual([command]);
  expect(state.closed).toBe(true);
});

test("ignores output from another pane", async () => {
  const command = "printf 'ltx-printed-ok\\n'";
  const { pane } = fakePane({
    endAfterEvents: true,
    events: [{ data: "ltx-printed-ok\r\n", kind: "output", paneId: "%9" }],
  });

  await expect(
    runPane(pane as Parameters<typeof runPane>[0], command, { until: "ltx-printed-ok" }),
  ).rejects.toThrow(LibTmuxException);
});

test("rejects when the event stream ends before a match", async () => {
  const { pane } = fakePane({ endAfterEvents: true, events: [] });

  await expect(
    runPane(pane as Parameters<typeof runPane>[0], "true", { until: "ltx-never" }),
  ).rejects.toThrow("the tmux event stream ended before a match");
});

test("times out and disposes the stream when nothing prints the marker", async () => {
  const { pane, state } = fakePane({ endAfterEvents: false, events: [] });

  await expect(
    runPane(pane as Parameters<typeof runPane>[0], "true", {
      timeoutMs: 25,
      until: "ltx-never",
    }),
  ).rejects.toThrow(WaitTimeout);
  expect(state.closed).toBe(true);
});

test("refuses an empty until", async () => {
  const { pane } = fakePane({ endAfterEvents: true, events: [] });

  await expect(
    runPane(pane as Parameters<typeof runPane>[0], "true", { until: "" }),
  ).rejects.toThrow(TypeError);
});

test("refuses a pane that is not in a session", async () => {
  const { pane } = fakePane({ endAfterEvents: true, events: [], withSession: false });

  await expect(
    runPane(pane as Parameters<typeof runPane>[0], "true", { until: "ltx-ok" }),
  ).rejects.toThrow("Pane.run attaches to the pane's session");
});
