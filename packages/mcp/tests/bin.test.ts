import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

/**
 * The server started the way npm actually starts it.
 *
 * `bin` is installed as a symlink, so `process.argv[1]` is the link while
 * `import.meta.url` is what it points at. A guard comparing those raw is always
 * false through a symlink, and the process then exits with status 0 having
 * served nothing — a client sees a server that starts and offers no tools,
 * which is the hardest shape of broken to notice.
 *
 * Nothing else here covers it: the package tests import the module, and the
 * library's install canary installs `libtmux` and imports it by name. Neither
 * runs this file as a program through a link.
 */
const built = fileURLToPath(new URL("../dist/server.js", import.meta.url));

/**
 * Say what is missing rather than reporting it as a broken server.
 *
 * This suite runs the emitted program, so it needs the build that `test` runs
 * first. Without it Node answers MODULE_NOT_FOUND on stderr and every
 * assertion here fails describing a server that never started — which is how
 * a stale local `dist` let this pass on one machine and fail in CI.
 */
if (!existsSync(built)) {
  throw new Error(`${built} is not built; run \`bun run build\` in packages/mcp first`);
}

async function handshake(command: string): Promise<{ tools: number; stderr: string }> {
  const child = Bun.spawn(["node", command], {
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const frames = [
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "bin-test", version: "0" },
        protocolVersion: "2024-11-05",
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
  ];
  void child.stdin.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  await child.stdin.flush();

  const deadline = setTimeout(() => child.kill(), 20_000);
  let text = "";
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- reading a stream is sequential by nature.
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('"id":2')) break;
    }
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
  const stderr = await new Response(child.stderr).text();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const message = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
    if (message.id === 2) return { stderr, tools: message.result?.tools?.length ?? 0 };
  }
  return { stderr, tools: 0 };
}

describe("the installed program", () => {
  test("serves when run through the symlink npm installs it as", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ltx-bin-"));
    try {
      const link = join(directory, "libtmux-mcp");
      await symlink(built, link);

      // Both spellings must serve. Through the real path is what a checkout
      // does; through the link is what `npm i -g` and `npx` do.
      const direct = await handshake(built);
      const linked = await handshake(link);

      expect(direct.tools).toBeGreaterThan(0);
      expect(linked.tools).toBeGreaterThan(0);
      expect(linked.tools).toBe(direct.tools);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  test("says which authority it is running with, on stderr", async () => {
    // stdout is the protocol. `handshake` parses every line it reads there as
    // JSON-RPC, so a banner written to the wrong stream fails this by
    // throwing rather than by this assertion.
    const { stderr } = await handshake(built);

    expect(stderr).toContain("mutating");
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
  }, 60_000);
});
