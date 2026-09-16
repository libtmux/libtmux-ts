import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { normalize } from "../src/normalize.ts";
import { connection } from "../src/tmux.ts";
import { extensionPlan } from "../src/extensions.ts";
import type { Document } from "../src/documents.ts";

const context = { cwd: "/project", env: { HOME: "/home/test" } };

test.each([
  [{ before_scrip: "touch ignored" }, "workspace.before_scrip"],
  [{ windows: [{ shell_command_befor: "touch ignored" }] }, "windows[0].shell_command_befor"],
  [
    { windows: [{ panes: [{ shell_commmand: "touch ignored" }] }] },
    "windows[0].panes[0].shell_commmand",
  ],
  [
    { windows: [{ panes: [{ shell_command: [{ cmd: "touch executed", entter: false }] }] }] },
    "windows[0].panes[0].shell_command[0].entter",
  ],
  [
    { workspace_builder_options: { pane_readines: "never" } },
    "workspace_builder_options.pane_readines",
  ],
  [{ enter: false }, "workspace.enter"],
  [{ windows: [{ global_options: {} }] }, "windows[0].global_options"],
  [{ windows: [{ panes: [{ options: {} }] }] }, "windows[0].panes[0].options"],
] satisfies [Document, string][])(
  "native execution rejects unrecognized field %j",
  (fields, path) => {
    expect(() =>
      normalize({ session_name: "dev", windows: [{}], ...fields }, "/project/dev.yaml", context),
    ).toThrow(`Unsupported field: ${path}`);
  },
);

test("a genuine unsupported field's refusal suggests the x- prefix", () => {
  expect(() =>
    normalize({ session_name: "dev", windows: [{}], bogus: 1 }, "/project/dev.yaml", context),
  ).toThrow(/Unsupported field: workspace\.bogus.*x-/);
});

test("x- prefixed keys are inert at every scope: workspace, window, and pane", () => {
  const spec = normalize(
    {
      session_name: "dev",
      "x-workspace-note": "ignored",
      windows: [
        {
          "x-window-note": "ignored",
          panes: [{ "x-pane-note": "ignored", shell_command: "echo hi" }],
        },
      ],
    },
    "/project/dev.yaml",
    context,
  );
  expect(spec.windows[0]!.panes[0]!.commands.map((command) => command.cmd)).toEqual(["echo hi"]);
});

test("native execution retains descriptions and open option and environment names", () => {
  const command = { cmd: "printf example", enter: false, sleep_before: null, sleep_after: 0 };
  const document = {
    session_name: "dev",
    description: "Session description",
    plugins: [],
    workspace_builder: " ",
    workspace_builder_paths: [],
    workspace_builder_options: { pane_readiness: "never" },
    options: { "@session-metadata": "retained" },
    global_options: { "@global-metadata": 1 },
    environment: { CONFIG_METADATA: "retained" },
    windows: [
      {
        description: "Window description",
        window_name: "main",
        window_index: "1",
        layout: "tiled",
        options: { "@window-metadata": true },
        options_after: { "@after-metadata": "retained" },
        panes: [{ description: "Pane description", shell_command: [command], focus: true }],
      },
    ],
  };
  const spec = normalize(document, "/project/dev.yaml", context);
  expect(spec.data).toEqual(document);
  expect(spec.windows[0]!.panes[0]!.commands).toEqual([command]);
  expect(spec.environment).toEqual(document.environment);
});

test("delegated extensions retain opaque fields and existing common-value validation", async () => {
  const io = { stdin: Readable.from([]), stdout: new Writable(), stderr: new Writable() };
  const document = {
    session_name: "dev",
    plugins: ["example.Plugin"],
    extension_root: { custom: true },
    workspace_builder_options: { plugin_setting: "retained" },
    windows: [
      {
        extension_window: true,
        panes: [
          { extension_pane: true, shell_command: [{ cmd: "true", extension_command: true }] },
        ],
      },
    ],
  };
  expect(
    (await extensionPlan(document, "/project/dev.yaml", { ...context, ...io }, false))?.data,
  ).toEqual(document);
  await expect(
    extensionPlan(
      { ...document, windows: [{ focus: "invalid" }] },
      "/project/dev.yaml",
      { ...context, ...io },
      false,
    ),
  ).rejects.toThrow("focus must be boolean");
  const custom = { session_name: "dev", workspace_builder: "example:Builder", opaque: [true] };
  expect(
    (await extensionPlan(custom, "/project/dev.yaml", { ...context, ...io }, false))?.data,
  ).toEqual(custom);
});

test("bootstrap resolution preserves command arguments in directories with spaces", () => {
  const base = "/project/workspace files";
  const bootstrap = (before_script: string) =>
    normalize({ session_name: "dev", windows: [{}], before_script }, `${base}/dev.yaml`, context)
      .bootstrap;
  expect(bootstrap("./before.sh 'a b' '' ../argument")).toEqual([
    `${base}/before.sh`,
    "a b",
    "",
    "../argument",
  ]);
  expect(bootstrap("'./before script.sh' '$(printf literal)' ")).toEqual([
    `${base}/before script.sh`,
    "$(printf literal)",
  ]);
  expect(bootstrap("printf 'a b'")).toEqual(["printf", "a b"]);
});

test("relative environment and option values resolve against the workspace file", () => {
  const base = "/project/workspaces";
  const spec = normalize(
    {
      session_name: "dev",
      environment: { SESSION_LOG: "./session.log" },
      windows: [
        {
          environment: { WINDOW_LOG: "./window.log" },
          options: { "@window-log": "./window.log" },
          panes: [{ environment: { PANE_LOG: "./pane.log" } }, {}],
        },
      ],
    },
    `${base}/dev.yaml`,
    context,
  );
  const window = spec.windows[0]!;
  expect(spec.environment).toEqual({ SESSION_LOG: `${base}/session.log` });
  expect(window.data.options).toEqual({ "@window-log": `${base}/window.log` });
  expect(window.panes[0]!.environment).toEqual({
    SESSION_LOG: `${base}/session.log`,
    PANE_LOG: `${base}/pane.log`,
  });
  expect(window.panes[1]!.environment).toEqual({
    SESSION_LOG: `${base}/session.log`,
    WINDOW_LOG: `${base}/window.log`,
  });
  const delegated = normalize(
    { session_name: "dev", windows: [{ panes: [{ options: { "@pane-log": "./pane.log" } }] }] },
    `${base}/dev.yaml`,
    context,
    undefined,
    { allowExtensionFields: true },
  );
  expect(delegated.windows[0]!.panes[0]!.data.options).toEqual({ "@pane-log": `${base}/pane.log` });
});

test("an empty pane list keeps the window's implicit pane", () => {
  const spec = normalize(
    { session_name: "dev", windows: [{ panes: [] }, {}] },
    "/project/dev.yaml",
    context,
  );
  expect(spec.windows.map((window) => window.panes.length)).toEqual([1, 1]);
  expect(spec.windows[0]!.panes[0]!.commands).toEqual([]);
  expect(spec.data.windows).toEqual([{ panes: [] }, {}]);
});

test("focus accepts the quoted strings tmuxp freeze emits and coerces them to booleans", () => {
  const spec = normalize(
    {
      session_name: "dev",
      windows: [
        { focus: "true", panes: [{ focus: "false" }, { focus: "true" }] },
        { focus: "false", panes: [{}] },
      ],
    },
    "/project/dev.yaml",
    context,
  );
  expect(spec.windows[0]!.data.focus).toBe(true);
  expect(spec.windows[0]!.panes[0]!.data.focus).toBe(false);
  expect(spec.windows[0]!.panes[1]!.data.focus).toBe(true);
  expect(spec.windows[1]!.data.focus).toBe(false);
});

test("execution shapes reject malformed options and toggles before creating anything", () => {
  const invalid: Document[] = [
    { options: [] },
    { global_options: { status: {} } },
    { workspace_builder_options: { pane_readiness: "sometimes" } },
    { windows: [{ focus: "yes" }] },
    { windows: [{ panes: [{ suppress_history: "false" }] }] },
    { windows: [{ panes: [{ sleep_before: -1 }] }] },
    { windows: [{ panes: [{ sleep_after: "1" }] }] },
    { windows: [{ panes: [{ shell_command: [{ cmd: "true", sleep_before: Infinity }] }] }] },
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
