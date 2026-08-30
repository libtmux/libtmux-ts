import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const legacyModule = /(?:^|[/])run_root\.(?:[cm]?[jt]s|[jt]sx)/u;
const implementationModule =
  /(?:^|[/])(?:cleanup|control_mode|deadlines|fixture_launch|handle_prototypes|node22|process_identity|reaper|records|supervisor|temp_root|test_server)\.(?:[cm]?[jt]s|[jt]sx)/u;
const internalTestDirectory = "packages/libtmux/src/_internal/test/";
const testkitEntrypoint = "packages/libtmux/src/_internal/test/testkit.ts";
const boundaryChecker = "scripts/check-testkit-boundary.ts";
const recoveryAuthority = ["restore", "ReservationCapability"].join("");
const recoveryAuthorityFiles = new Set([
  "packages/libtmux/src/_internal/test/fixture_launch.ts",
  "packages/libtmux/src/_internal/test/reaper.ts",
]);
const listed =
  await new Bun.$.Shell()`git ls-files --cached --others --exclude-standard -- "*.ts" "*.mts" "*.cts" "*.tsx" "*.js" "*.mjs" "*.cjs" "*.jsx"`
    .cwd(repositoryRoot)
    .text();
const failures: string[] = [];

for (const file of listed.split("\n").filter((line) => line !== "")) {
  if (file === boundaryChecker) continue;
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
    if (line.includes(recoveryAuthority) && !recoveryAuthorityFiles.has(file)) {
      failures.push(`${file}:${String(index + 1)}: recovery authority belongs only to the reaper`);
      continue;
    }
    if (
      file.startsWith(internalTestDirectory) &&
      file !== testkitEntrypoint &&
      /(?:^|[/])testkit\.(?:[cm]?[jt]s|[jt]sx)/u.test(line)
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
