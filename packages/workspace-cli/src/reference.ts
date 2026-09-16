import type { Command } from "commander";
import { createParser, type CompletionHint } from "./parser.ts";

export interface ArgumentReference {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
  choices: string[];
  completion?: CompletionHint | undefined;
}

export interface OptionReference {
  flags: string;
  short?: string | undefined;
  long?: string | undefined;
  description: string;
  value: "required" | "optional" | "none";
  variadic: boolean;
  choices: string[];
  default?: unknown;
  completion?: CompletionHint | undefined;
}

export interface CommandReference {
  path: string[];
  description: string;
  arguments: ArgumentReference[];
  options: OptionReference[];
  subcommands: string[];
}

export interface CommandCatalog {
  program: string;
  commands: CommandReference[];
}

export function commandCatalog(
  parser = createParser({ stdout: () => {}, stderr: () => {} }),
): CommandCatalog {
  const commands: CommandReference[] = [];
  function visit(command: Command, path: string[]) {
    const help = command.createHelp();
    const children = help.visibleCommands(command);
    commands.push({
      path,
      description: command.description(),
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        required: argument.required,
        variadic: argument.variadic,
        description: argument.description,
        choices: argument.argChoices ?? [],
        completion: parser.completionHints.get(argument),
      })),
      options: help.visibleOptions(command).map((option) => ({
        flags: option.flags,
        short: option.short,
        long: option.long,
        description: option.description,
        value: option.required ? "required" : option.optional ? "optional" : "none",
        variadic: Boolean(option.variadic),
        choices: option.argChoices ?? [],
        default: option.defaultValue,
        completion: parser.completionHints.get(option),
      })),
      subcommands: children.map((child) => child.name()),
    });
    for (const child of children) visit(child, [...path, child.name()]);
  }
  visit(parser.command, []);
  return { program: parser.command.name(), commands };
}

function code(value: string): string {
  const fence = "`".repeat(
    Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length)) + 1,
  );
  return `${fence} ${value} ${fence}`;
}

export function commandMarkdown(catalog: CommandCatalog): string {
  const lines = [
    "# Workspace command reference",
    "",
    "Commands and options come from the native parser. See the [CLI README](../README.md)",
    "for operation behavior, output, and development status.",
    "",
    "Root options precede the subcommand. Each command lists its own accepted options.",
    "",
  ];
  for (const command of catalog.commands) {
    const name = [catalog.program, ...command.path].join(" ");
    const arguments_ = command.arguments.map((argument) => {
      const value = argument.name + (argument.variadic ? "..." : "");
      return argument.required ? `<${value}>` : `[${value}]`;
    });
    const usage = [
      name,
      ...(command.options.length ? ["[options]"] : []),
      ...arguments_,
      ...(command.subcommands.length ? ["[command]"] : []),
    ].join(" ");
    lines.push(`## ${name}`, "", command.description, "", `Usage: ${code(usage)}`, "");
    if (command.subcommands.length)
      lines.push(`Commands: ${command.subcommands.map(code).join(", ")}.`, "");
    for (const argument of command.arguments) {
      const choices = argument.choices.length
        ? ` Choices: ${argument.choices.map(code).join(", ")}.`
        : "";
      lines.push(
        `- ${code(argument.name)}${argument.description ? `: ${argument.description}` : ""}${choices}`,
      );
    }
    if (command.arguments.length) lines.push("");
    for (const option of command.options) {
      const choices = option.choices.length
        ? ` Choices: ${option.choices.map(code).join(", ")}.`
        : "";
      const fallback =
        option.default === undefined ? "" : ` Default: ${code(JSON.stringify(option.default))}.`;
      lines.push(`- ${code(option.flags)}: ${option.description}${choices}${fallback}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
