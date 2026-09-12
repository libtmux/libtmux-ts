import { expect, test } from "bun:test";
import { Argument, Option } from "commander";
import { createParser } from "../src/parser.ts";
import { commandCatalog, commandMarkdown } from "../src/reference.ts";

test("reference includes native options, implicit help, and undescribed positional arguments", () => {
  const catalog = commandCatalog();
  const load = catalog.commands.find((command) => command.path.join(" ") === "load")!;
  expect(load.arguments).toMatchObject([
    { name: "workspace_files", required: true, variadic: true, completion: "file" },
  ]);
  expect(load.options.map((option) => option.long)).toContain("--help");
  expect(load.options.map((option) => option.long)).toContain("--ndjson");
  expect(load.options.map((option) => option.long)).not.toContain("--log-level");
  const imported = catalog.commands.find(
    (command) => command.path.join(" ") === "import tmuxinator",
  )!;
  expect(imported.options.find((option) => option.long === "--save-to")).toMatchObject({
    value: "required",
    completion: "file",
  });
  expect(imported.options.find((option) => option.long === "--workspace-format")?.choices).toEqual([
    "yaml",
    "json",
  ]);
  expect(
    catalog.commands.find((command) => command.path.join(" ") === "completion")?.arguments[0]
      ?.choices,
  ).toEqual(["bash", "zsh", "fish"]);
});

test("reference reads added definitions from the actual command objects", () => {
  const parser = createParser({ stdout: () => {}, stderr: () => {} });
  parser.commands
    .get("ls")!
    .addOption(new Option("--fixture <value>", "A fixture.").choices(["a", "b"]));
  parser.command
    .command("fixture")
    .description("Fixture command.")
    .addArgument(new Argument("<operand>"));
  const catalog = commandCatalog(parser);
  const markdown = commandMarkdown(catalog);
  expect(
    catalog.commands.find((command) => command.path.join(" ") === "fixture")?.arguments[0]?.name,
  ).toBe("operand");
  expect(markdown).toContain("--fixture <value>");
  expect(markdown).toContain("Fixture command.");
  expect(markdown).toBe(commandMarkdown(commandCatalog(parser)));
});
