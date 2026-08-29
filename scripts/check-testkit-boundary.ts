import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const legacyModule = /(?:^|[/])run_root\.(?:js|ts)/u;
const testkitEntrypoint = "packages/libtmux/src/_internal/test/testkit.ts";
const listed = await new Bun.$.Shell()`git ls-files "*.ts"`.cwd(repositoryRoot).text();
const failures: string[] = [];

for (const file of listed.split("\n").filter((line) => line !== "")) {
  if (file === testkitEntrypoint) continue;
  // eslint-disable-next-line no-await-in-loop -- diagnostics preserve repository order.
  const source = await Bun.file(join(repositoryRoot, file)).text();
  for (const [index, line] of source.split("\n").entries()) {
    if (!legacyModule.test(line)) continue;
    failures.push(`${file}:${String(index + 1)}: import through _internal/test/testkit`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Legacy test-runtime imports:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Test-runtime imports use the supported testkit entrypoint\n");
