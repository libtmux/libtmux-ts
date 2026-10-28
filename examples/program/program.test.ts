import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { VersionTooLowError } from "../../packages/libtmux/src/errors.js";
import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import { followOutput, listFiles, prependLine } from "./program.js";

/** Program runs need tmux 3.8; below it the first test checks the refusal and the rest return early. */
async function supported(server: Server): Promise<boolean> {
  return server.versionAtLeast("3.8");
}

describe("program", () => {
  test("lists a directory from the program's own output", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      const directory = await mkdtemp(join(tmpdir(), "ltx-example-program-"));
      try {
        if (!(await supported(server))) {
          await expect(listFiles(server, directory)).rejects.toBeInstanceOf(VersionTooLowError);
          return;
        }
        await writeFile(join(directory, "b"), "");
        await writeFile(join(directory, "a"), "");
        expect(await listFiles(server, directory)).toEqual(["a", "b"]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  }, 60_000);

  test.skipIf(Bun.which("vim") === null)(
    "drives vim with keys and waits for it to quit",
    async () => {
      await withServer(async (fixture) => {
        const server = new Server({
          environment: fixture.controllerEnvironment,
          socketPath: fixture.socketPath,
          tmuxBin: fixture.tmuxExecutable,
        });
        if (!(await supported(server))) return;
        const directory = await mkdtemp(join(tmpdir(), "ltx-example-program-"));
        try {
          const file = join(directory, "notes.txt");
          await writeFile(file, "second\n");
          expect(await prependLine(server, file, "first")).toBe(0);
          expect(await readFile(file, "utf8")).toBe("first\nsecond\n");
        } finally {
          await rm(directory, { force: true, recursive: true });
        }
      });
    },
    60_000,
  );

  test("follows every byte a program writes", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      if (!(await supported(server))) return;
      let text = "";
      const exitCode = await followOutput(server, ["sh", "-c", "seq 1 3; exit 4"], (chunk) => {
        text += chunk;
      });
      expect(text).toBe("1\r\n2\r\n3\r\n");
      expect(exitCode).toBe(4);
    });
  }, 60_000);
});
