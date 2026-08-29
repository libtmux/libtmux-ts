import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const legacyModule = /(?:^|[/])run_root\.(?:js|ts)/u;
const implementationModule =
  /(?:^|[/])(?:cleanup|fixture_launch|reaper|records|supervisor)\.(?:js|ts)/u;
const internalTestDirectory = "packages/libtmux/src/_internal/test/";
const testkitEntrypoint = "packages/libtmux/src/_internal/test/testkit.ts";
const listed = await new Bun.$.Shell()`rg --files --glob "*.ts"`.cwd(repositoryRoot).text();
const failures: string[] = [];

for (const file of listed.split("\n").filter((line) => line !== "")) {
  // eslint-disable-next-line no-await-in-loop -- diagnostics preserve repository order.
  const source = await Bun.file(join(repositoryRoot, file)).text();
  for (const [index, line] of source.split("\n").entries()) {
    if (legacyModule.test(line)) {
      failures.push(`${file}:${String(index + 1)}: run_root no longer exists; import testkit`);
      continue;
    }
    if (!file.startsWith(internalTestDirectory) && implementationModule.test(line)) {
      failures.push(`${file}:${String(index + 1)}: import through _internal/test/testkit`);
      continue;
    }
    if (
      file.startsWith(internalTestDirectory) &&
      file !== testkitEntrypoint &&
      /(?:^|[/])testkit\.(?:js|ts)/u.test(line)
    ) {
      failures.push(
        `${file}:${String(index + 1)}: implementation modules must import their leaves`,
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Test-runtime boundary violations:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Test-runtime imports use the supported testkit entrypoint\n");
