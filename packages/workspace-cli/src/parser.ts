import { Command, InvalidArgumentError, Option } from "commander";
import grammar from "./grammar.json" with { type: "json" };

export type OutputMode = "human" | "json" | "ndjson";
export type Request = { command: string; values: Record<string, unknown>; mode: OutputMode };
export type ParserIO = { stdout: (text: string) => void; stderr: (text: string) => void };
type Action = {
  dest: string;
  default: unknown;
  required: boolean;
  nargs: string | number | null;
  choices: string[] | null;
  const: unknown;
  help: string | null;
  flags: string[];
};
type Definition = {
  command: string;
  actions: Action[];
  exclusive_groups: string[][];
  required_groups?: string[][];
};
const inventory: Definition[] = grammar;

const descriptions: Record<string, string> = {
  "": "Manage tmux workspaces from YAML and JSON configuration.",
  load: "Load workspace files, attach to existing sessions, or append windows.",
  freeze: "Capture a live tmux session as a workspace document.",
  convert: "Convert a workspace between YAML and JSON.",
  edit: "Open a discovered workspace in your editor.",
  "debug-info": "Show runtime, configuration, and tmux diagnostics.",
  ls: "List project and saved workspace files.",
  search: "Search workspace names, sessions, windows, and pane commands.",
  shell: "Open the Python tmuxp shell with the selected tmux context.",
  import: "Import a teamocil or tmuxinator workspace.",
  "import teamocil": "Convert a teamocil workspace to tmuxp configuration.",
  "import tmuxinator": "Convert a tmuxinator workspace to tmuxp configuration.",
};

function optionFor(item: Action): Option {
  const flags = [...item.flags].sort((a, b) => a.length - b.length).join(", ");
  const option = new Option(flags + (item.nargs === 0 ? "" : ` <${item.dest}>`), item.help ?? "");
  if (item.choices) option.choices(item.choices);
  if (item.default !== null && item.default !== "==SUPPRESS==") option.default(item.default);
  if (item.dest === "field")
    option.argParser((value, previous: string[] | null) => [...(previous ?? []), value]);
  if (item.dest === "panel_lines")
    option.argParser((value) => {
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < -1) {
        throw new InvalidArgumentError("expected an integer at least -1");
      }
      return Number(value);
    });
  if (item.flags.includes("--no-startup")) option.description = "Do not load Python startup files.";
  if (item.flags.includes("--no-vi-mode")) option.description = "Disable vi editing mode.";
  return option;
}

export function createParser(io: ParserIO): {
  command: Command;
  commands: Map<string, Command>;
  request: () => Request;
} {
  const root = new Command("tmux-workspace").enablePositionalOptions();
  const commands = new Map<string, Command>([["", root]]);
  const events: { scope: string; dest: string; value: unknown }[] = [];
  let request: Request | undefined;
  const definitions = [...inventory].sort(
    (a, b) => a.command.split(" ").length - b.command.split(" ").length,
  );
  for (const spec of definitions) {
    const name = spec.command.replace(/^tmuxp ?/, "");
    const words = name.split(" ");
    let command = commands.get(name);
    if (!command) {
      const parent = commands.get(words.slice(0, -1).join(" "))!;
      command = parent.command(words.at(-1)!);
      commands.set(name, command);
    }
    const current = command;
    current
      .description(descriptions[name] ?? name)
      .exitOverride()
      .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
    const options: { item: Action; option: Option }[] = [];
    for (const item of spec.actions) {
      if (item.dest === "help") continue;
      if (item.dest === "version") {
        current.version("0.1.0-alpha.8", "-V, --version");
        continue;
      }
      if (!item.flags.length) {
        const required =
          item.required || spec.required_groups?.some((group) => group.includes(item.dest));
        const argument =
          item.nargs === "+"
            ? `<${item.dest}...>`
            : item.nargs === "*"
              ? `[${item.dest}...]`
              : item.nargs === "?" && !required
                ? `[${item.dest}]`
                : `<${item.dest}>`;
        current.argument(argument, item.help ?? "");
        continue;
      }
      const option = optionFor(item);
      current.addOption(option);
      current.on(`option:${option.name()}`, () =>
        events.push({
          scope: name,
          dest: item.dest,
          value: item.nargs === 0 ? item.const : current.getOptionValue(option.attributeName()),
        }),
      );
      options.push({ item, option });
    }
    for (const group of spec.exclusive_groups) {
      const members = options
        .filter(({ item }) => group.includes(item.dest))
        .map(({ option }) => option);
      for (const option of members)
        option.conflicts(
          members.filter((other) => other !== option).map((other) => other.attributeName()),
        );
    }
    for (const [flag, dest, description] of [
      ["--json", "output_json", "Write JSON; machine operations never prompt."],
      ["--ndjson", "output_ndjson", "Stream NDJSON; takes precedence over --json."],
      [
        "--color <mode>",
        "color",
        "Human color: auto, always, or never. Machine output disables color.",
      ],
    ] as const) {
      if (current.options.some((option) => option.long === flag.split(" ")[0])) continue;
      const option = new Option(flag, description);
      if (dest === "color") option.choices(["auto", "always", "never"]);
      current.addOption(option);
      current.on(`option:${option.name()}`, () =>
        events.push({ scope: name, dest, value: current.getOptionValue(option.attributeName()) }),
      );
    }
    if (["convert", "import teamocil", "import tmuxinator"].includes(name)) {
      for (const [flag, dest, description] of [
        ["--save-to <path>", "save_to", "Write to this destination instead of machine stdout."],
        ["--workspace-format <format>", "workspace_format", "Document format: yaml or json."],
        ["--force", "force", "Allow replacing an existing destination."],
      ] as const) {
        const option = new Option(flag, description);
        if (dest === "workspace_format") option.choices(["yaml", "json"]);
        current.addOption(option);
        current.on(`option:${option.name()}`, () =>
          events.push({ scope: name, dest, value: current.getOptionValue(option.attributeName()) }),
        );
      }
    }
    current.action(() => {
      const values: Record<string, unknown> = {};
      for (const definition of definitions.filter(
        (item) => item.command === "tmuxp" || item === spec,
      )) {
        const node = commands.get(definition.command.replace(/^tmuxp ?/, ""))!;
        let position = 0;
        for (const item of definition.actions) {
          if (["help", "version"].includes(item.dest)) continue;
          if (!Object.hasOwn(values, item.dest)) values[item.dest] = item.default;
          if (!item.flags.length)
            values[item.dest] = node.processedArgs[position++] ?? (item.nargs === "*" ? [] : null);
        }
      }
      for (const event of events) {
        if (!event.scope || event.scope === name || name.startsWith(event.scope + " "))
          values[event.dest] = event.value;
      }
      request = {
        command: name,
        values,
        mode: values.output_ndjson ? "ndjson" : values.output_json ? "json" : "human",
      };
    });
  }
  return {
    command: root,
    commands,
    request: () => {
      if (!request) throw new Error("No command was parsed");
      return request;
    },
  };
}
