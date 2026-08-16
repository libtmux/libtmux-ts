import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNode22 } from "../src/_internal/test/node22.js";

/**
 * Install the tarball into a project that has never seen this repository.
 *
 * `test:package` reads the tarball; this one uses it. The project is empty
 * apart from the tarball, so nothing resolves through the workspace — no
 * `paths`, no hoisted `node_modules`, no source tree — and what `exports` names
 * has to be all there is.
 *
 * Node at the floor the package claims, not Bun: the tarball is what a Node
 * consumer installs.
 */

const tsRoot = fileURLToPath(new URL("..", import.meta.url));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function run(
  command: readonly string[],
  cwd: string,
): Promise<{ stderr: string; stdout: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    // The package has no runtime dependencies, so this install is offline.
    env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    fail(`${command.join(" ")} exited ${String(exitCode)}\n${stdout}${stderr}`);
  }
  return { stderr, stdout };
}

const manifest = JSON.parse(await readFile(join(tsRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const tarball = join(tsRoot, `${manifest.name}-${manifest.version}.tgz`);

// `ltx` so a sweep can tell this apart from another libtmux port's leavings.
const project = await mkdtemp(join(tmpdir(), "ltx-install-"));
const node = await resolveNode22();

try {
  await run(["bun", "pm", "pack"], tsRoot);

  await writeFile(
    join(project, "package.json"),
    `${JSON.stringify({ name: "ltx-install-canary", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
  );
  await run(["npm", "install", "--no-save", tarball], project);

  // Resolving proves `exports` and `dist` agree; calling proves the modules
  // evaluate, which a missing internal file fails at rather than at import.
  const probe = join(project, "probe.mjs");
  await writeFile(
    probe,
    [
      `import { Server, TmuxTransportError, PaneDirection } from "${manifest.name}";`,
      `import { parseLegacyWhere } from "${manifest.name}/selection";`,
      "const server = new Server({ socketName: 'ltx-canary' });",
      "if (typeof server.snapshot !== 'function') throw new Error('Server.snapshot is missing');",
      "if (typeof server.watch !== 'function') throw new Error('Server.watch is missing');",
      "if (typeof TmuxTransportError !== 'function') throw new Error('TmuxTransportError is missing');",
      "if (typeof parseLegacyWhere !== 'function') throw new Error('parseLegacyWhere is missing');",
      "if (PaneDirection.Above === undefined) throw new Error('PaneDirection is missing');",
      "const where = parseLegacyWhere('window', { name__contains: 'logs' });",
      "if (where.model !== 'window') throw new Error('parseLegacyWhere answered the wrong model');",
      "process.stdout.write('ok\\n');",
      "",
    ].join("\n"),
  );
  const { stdout } = await run([node, probe], project);
  if (stdout.trim() !== "ok") {
    fail(`the installed package answered ${JSON.stringify(stdout.trim())}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      installed: `${manifest.name}@${manifest.version}`,
      node: node.split("/").at(-1) ?? "node",
      protocol: "libtmux-install-canary-v1",
      status: "passed",
    })}\n`,
  );
} finally {
  await Promise.all([rm(project, { force: true, recursive: true }), rm(tarball, { force: true })]);
}
