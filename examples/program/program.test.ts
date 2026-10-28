import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { LibTmuxError, VersionTooLowError } from "../../packages/libtmux/src/errors.js";
import { Server } from "../../packages/libtmux/src/server.js";
import { withServer } from "../test-support/with-server.js";
import {
  followOutput,
  listFiles,
  prependLine,
  runBeside,
  sortLines,
  startWorker,
} from "./program.js";

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
      await expect(
        followOutput(server, ["seq", "1", "300000"], () => undefined),
      ).rejects.toBeInstanceOf(LibTmuxError);
    });
  }, 60_000);

  test("sorts lines given as the program's stdin", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      if (!(await supported(server))) return;
      expect(await sortLines(server, "pear\napple\n")).toEqual(["apple", "pear"]);
    });
  }, 60_000);

  test("leaves a program's output beside a pane, which keeps its focus", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      if (!(await supported(server))) return;
      const pane = (await server.panes()).toArray()[0];
      if (pane === undefined) throw new Error("the fixture has a pane");
      expect(await runBeside(server, pane, ["echo", "built"])).toBe(true);
      const beside = (await server.panes()).toArray().find((each) => each.id !== pane.id);
      expect((await beside?.capture())?.filter((line) => line !== "")).toEqual(["built"]);
      expect((await server.cmd("display-message", ["-p", "#{pane_id}"]))[0]).toBe(pane.id);
    });
  }, 60_000);

  test("starts a worker that ends when its caller kills it", async () => {
    await withServer(async (fixture) => {
      const server = new Server({
        environment: fixture.controllerEnvironment,
        socketPath: fixture.socketPath,
        tmuxBin: fixture.tmuxExecutable,
      });
      if (!(await supported(server))) return;
      const worker = await startWorker(server, ["sleep", "60"]);
      expect(await server.hasSession(worker.sessionName)).toBe(true);
      await worker.kill();
      expect(await server.hasSession(worker.sessionName)).toBe(false);
    });
  }, 60_000);
});
