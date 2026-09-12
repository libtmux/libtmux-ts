import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { normalize } from "../src/normalize.ts";
import { connection } from "../src/tmux.ts";
import type { Document } from "../src/documents.ts";

const context = { cwd: "/project", env: { HOME: "/home/test" } };

test("execution shapes reject malformed options and toggles before creating anything", () => {
  const invalid: Document[] = [
    { options: [] },
    { global_options: { status: {} } },
    { workspace_builder_options: { pane_readiness: "sometimes" } },
    { windows: [{ focus: "false" }] },
    { windows: [{ panes: [{ suppress_history: "false" }] }] },
    { windows: [{ window_index: 2147483648 }] },
  ];
  for (const document of invalid)
    expect(() =>
      normalize({ session_name: "dev", windows: [{}], ...document }, "/project/dev.yaml", context),
    ).toThrow();
});

test("the current tmux socket is resolved before the child environment is sanitized", () => {
  const io = { stdin: Readable.from([]), stdout: new Writable(), stderr: new Writable() };
  const local = {
    ...context,
    ...io,
    env: { ...context.env, TMUX: "/tmp/private, socket,123,0", TMUX_PANE: "%3" },
  };
  expect(connection({}, local).socketPath).toBe("/tmp/private, socket");
  expect(connection({ socket_path: "/tmp/explicit" }, local).socketPath).toBe("/tmp/explicit");
  expect(connection({ socket_name: "named" }, local).socketPath).toBeUndefined();
});

test("window indexes accept decimal integers and treat null as unspecified", () => {
  const index = (value: Document[string]) =>
    normalize(
      { session_name: "dev", windows: [{ window_index: value }] },
      "/project/dev.yaml",
      context,
    ).windows[0]!.index;
  expect(index(null)).toBeUndefined();
  expect(index(0)).toBe(0);
  expect(index("3")).toBe(3);
  for (const invalid of [false, true, [], [1], {}, "", " ", "1.5", "0x10"])
    expect(() => index(invalid)).toThrow();
});
