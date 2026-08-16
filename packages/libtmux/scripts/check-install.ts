import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNode22 } from "../src/_internal/test/node22.js";

/**
 * Install the tarball into a project that has never seen this repository.
 *
 * `test:package` reads the tarball; this one uses it. The difference is what
 * has actually shipped broken: a release whose `dist` was never built, and an
 * install command that 404'd. Both packed, both linted clean, and neither was
 * ever installed by anything before a user tried it.
 *
 * The project is empty apart from the tarball, so nothing here can resolve
 * through the workspace: no `paths`, no hoisted `node_modules`, no source tree
 * to fall back to. What the package says it exports has to be all there is.
 *
 * Node rather than Bun, at the floor the package claims. The tarball is what a
 * Node consumer installs, and the emitted declarations are what their
 * typechecker reads; running it under the toolchain that built it would prove
 * neither.
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
    // npm resolves nothing from the registry here — the package has no runtime
    // dependencies, which is what makes an offline install a real check rather
    // than a network test.
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

  // Import by name and use it. Resolving the entry point proves `exports` and
  // `dist` agree; constructing a Server proves the module actually evaluates,
  // which a missing internal file would fail at rather than at import.
  const probe = join(project, "probe.mjs");
  await writeFile(
    probe,
    [
      // The root entry point and one subpath, because `exports` names each
      // separately and a release has shipped with one of them pointing at
      // nothing.
      `import { Server, TmuxTransportError, PaneDirection } from "${manifest.name}";`,
      `import { parseLegacyWhere } from "${manifest.name}/selection";`,
      "const server = new Server({ socketName: 'ltx-canary' });",
      "if (typeof server.snapshot !== 'function') throw new Error('Server.snapshot is missing');",
      "if (typeof server.watch !== 'function') throw new Error('Server.watch is missing');",
      "if (typeof TmuxTransportError !== 'function') throw new Error('TmuxTransportError is missing');",
      "if (typeof parseLegacyWhere !== 'function') throw new Error('parseLegacyWhere is missing');",
      "if (PaneDirection.Above === undefined) throw new Error('PaneDirection is missing');",
      // Something that runs rather than merely resolves: a module that imports
      // a file the tarball left out fails at evaluation, not at import.
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
