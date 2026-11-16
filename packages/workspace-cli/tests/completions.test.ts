import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { completionScript } from "../src/completions.ts";
import type { CommandCatalog, OptionReference } from "../src/reference.ts";
import { writeProbe } from "../../libtmux/tests/support/fake_tmux.js";
import { startPty } from "./pty.ts";

function option(
  long: string,
  value: OptionReference["value"] = "none",
  extra: Partial<OptionReference> = {},
): OptionReference {
  return {
    flags: long,
    long,
    description: "A value with 'quotes' : [brackets] and $(false)",
    value,
    variadic: false,
    choices: [],
    ...extra,
  };
}

const common = [
  option("--json"),
  option("--ndjson"),
  option("--color", "required", { choices: ["auto", "always", "never"] }),
];
const catalog: CommandCatalog = {
  program: "tmux-workspace",
  commands: [
    {
      path: [],
      description: "Workspace",
      arguments: [],
      options: [option("--root-only"), ...common],
      subcommands: ["load", "import", "search"],
    },
    {
      path: ["load"],
      description: "Load",
      arguments: [
        {
          name: "file",
          required: true,
          variadic: true,
          description: "Workspace file",
          choices: [],
          completion: "file",
        },
      ],
      options: [
        ...common,
        option("--detached", "none", { short: "-d" }),
        option("--yes", "none", { short: "-y" }),
        option("--socket", "required", { short: "-S", completion: "file" }),
        option("--directory", "required", { completion: "directory" }),
        option("--choice", "required", { choices: ["two words", "value'quote"] }),
        option("--optional", "optional", { choices: ["first", "second"] }),
      ],
      subcommands: [],
    },
    {
      path: ["import"],
      description: "Import",
      arguments: [],
      options: common,
      subcommands: ["teamocil", "tmuxinator"],
    },
    {
      path: ["import", "teamocil"],
      description: "Teamocil",
      arguments: [
        {
          name: "source",
          required: true,
          variadic: false,
          description: "Source",
          choices: [],
          completion: "file",
        },
      ],
      options: [...common, option("--save-to", "required", { completion: "file" })],
      subcommands: [],
    },
    {
      path: ["import", "tmuxinator"],
      description: "Tmuxinator",
      arguments: [],
      options: common,
      subcommands: [],
    },
    {
      path: ["search"],
      description: "Search",
      arguments: [
        { name: "pattern", required: true, variadic: false, description: "Pattern", choices: [] },
      ],
      options: [
        ...common,
        option("--field", "required", { short: "-f", choices: ["name", "window"] }),
      ],
      subcommands: [],
    },
  ],
};

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ltx-workspace-completion-"));
  try {
    await writeProbe(join(root, "tmux-workspace"), {
      exit: 97,
      marker: join(root, "executed"),
      text: "attempted",
    });
    await writeFile(join(root, "file space.yaml"), "");
    await writeFile(join(root, "file:colon.yaml"), "");
    await mkdir(join(root, "folder space"));
    await body(root);
    expect(existsSync(join(root, "executed"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function run(shell: string, code: string, cwd: string) {
  const child = Bun.spawn(
    [Bun.which(shell) ?? shell, ...(shell === "fish" ? ["--no-config"] : []), "-c", code],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${cwd}:/usr/bin:/bin`, LC_ALL: "C", TERM: "xterm" },
    },
  );
  const [stdout, stderr, codeResult] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code: codeResult, stderr }).toEqual({ code: 0, stderr: "" });
  return stdout.trimEnd().split("\n").filter(Boolean);
}

for (const shell of ["bash", "fish"] as const) {
  test(`${shell} completes scoped commands, values and paths in the real shell`, async () => {
    await fixture(async (root) => {
      const script = join(root, `completion.${shell}`);
      await writeFile(script, completionScript(catalog, shell));
      const cases: [string[], string, boolean?][] = [
        [[""], "load"],
        [["lo"], "load"],
        [["import", "tea"], "teamocil"],
        [["load", "--r"], "--root-only", false],
        [["--r"], "--root-only"],
        [["load", "--color", "al"], "always"],
        [["load", "--color=al"], "--color=always"],
        [["load", "-S", "import", "--d"], "--detached"],
        [["load", "-dy", "--d"], "--detached"],
        [["load", "-Simport", "--d"], "--detached"],
        [["search", "-f", "name", "-f", "wi"], "window"],
        [["load", "--optional", "--c"], "--color"],
        [["load", "--", "--c"], "--color", false],
        [["load", "--directory", "fi"], "file space.yaml", false],
        [["load", "fi"], "file space.yaml"],
        [["import", "teamocil", "--save-to", "fi"], "file space.yaml"],
      ];
      if (shell === "fish") cases.push([["load", "file\\ s"], "file space.yaml"]);
      const commands = cases.map(([args]) => {
        const words = ["tmux-workspace", ...args];
        return shell === "bash"
          ? `COMP_WORDS=(${words.map(quote).join(" ")}); COMP_CWORD=$((${words.length} - 1)); COMP_LINE=${quote(words.join(" "))}; COMP_POINT=\${#COMP_LINE}; _tmux_workspace; printf '%s\\n' "\${COMPREPLY[@]}"; printf '\\0'`
          : `complete -C ${quote(words.map((word, i) => (i === words.length - 1 ? word : quote(word))).join(" "))}; printf '\\0'`;
      });
      const output = await run(shell, `source ${quote(script)}; ${commands.join("; ")}`, root);
      const results = output.join("\n").split("\0");
      for (const [index, [, expected, present = true]] of cases.entries()) {
        const values = results[index]!.trim()
          .split("\n")
          .map((line) => line.split("\t")[0]);
        expect(values.includes(expected)).toBe(present);
      }
    });
  });
}

/** Types each line and a Tab into the shell, with the tool's own key bound to capture the edit buffer. */
async function typedBuffers(root: string, shell: string, init: string, lines: string[]) {
  const buffers = join(root, "buffers");
  const captured = () =>
    existsSync(buffers) ? readFileSync(buffers, "utf8").split("\0").slice(0, -1) : [];
  const terminal = startPty(shell === "bash" ? [shell, "--norc", "--noprofile"] : [shell, "-f"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH}`,
      TERM: "xterm",
      LC_ALL: "C",
      HISTFILE: "/dev/null",
    },
  });
  try {
    terminal.write(`${init}\n`);
    await terminal.waitFor(() => existsSync(join(root, "ready")), 4000);
    for (const [index, line] of lines.entries()) {
      terminal.write(`${line}\t\x18`);
      // eslint-disable-next-line no-await-in-loop -- Each line is typed after the previous one lands.
      await terminal.waitFor(() => captured().length > index, 4000);
    }
    return captured();
  } finally {
    terminal.kill();
    await terminal.result;
  }
}

for (const [shell, autoload] of [
  ["bash", false],
  ["zsh", false],
  ["zsh", true],
] as const) {
  test(`${shell}${autoload ? " autoload" : ""} inserts completion text through its native terminal editor`, async () => {
    await fixture(async (root) => {
      const script = join(root, autoload ? "_tmux-workspace" : `completion.${shell}`);
      await writeFile(script, completionScript(catalog, shell));
      const zshLoad = autoload
        ? `fpath=(${quote(root)} $fpath); autoload -Uz compinit; compinit -i -D`
        : `autoload -Uz compinit; compinit -i -D; source ${quote(script)}`;
      const setup =
        shell === "bash"
          ? `source ${quote(script)}; bind 'set keyseq-timeout 1'; _capture() { printf '%s\\0' "$READLINE_LINE" >> ${quote(join(root, "buffers"))}; READLINE_LINE=; READLINE_POINT=0; }; bind -x '"\\C-x":_capture'`
          : `KEYTIMEOUT=1; ${zshLoad}; _capture() { printf '%s\\0' "$BUFFER" >> ${quote(join(root, "buffers"))}; BUFFER=; zle reset-prompt; }; zle -N _capture; bindkey '^X' _capture`;
      const init = `${setup}; PS1='prompt> '; : > ${quote(join(root, "ready"))}`;
      const cases: [string, string][] = [
        ["tmux-workspace lo", "tmux-workspace load "],
        ["tmux-workspace import tea", "tmux-workspace import teamocil "],
        ["tmux-workspace load --choice two", "tmux-workspace load --choice two\\ words "],
        ["tmux-workspace load --color al", "tmux-workspace load --color always "],
        ["tmux-workspace load --color=al", "tmux-workspace load --color=always "],
        ["tmux-workspace load -S import --det", "tmux-workspace load -S import --detached "],
        ["tmux-workspace load -dy --det", "tmux-workspace load -dy --detached "],
        ["tmux-workspace load -Sfile\\ s", "tmux-workspace load -Sfile\\ space.yaml "],
        ["tmux-workspace load -Simport --det", "tmux-workspace load -Simport --detached "],
        ["tmux-workspace load -- --colo", "tmux-workspace load -- --colo"],
        ["tmux-workspace load --root-o", "tmux-workspace load --root-o"],
        ["tmux-workspace load file\\ s", "tmux-workspace load file\\ space.yaml "],
        ["tmux-workspace load file:c", "tmux-workspace load file:colon.yaml "],
        ["tmux-workspace load --directory fol", "tmux-workspace load --directory folder\\ space/"],
      ];
      const typed = await typedBuffers(
        root,
        shell,
        init,
        cases.map(([input]) => input),
      );
      expect(typed).toEqual(cases.map(([, expected]) => expected));
    });
  });
}
