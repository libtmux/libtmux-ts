import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { readLaunchFrame } from "../support/launch_frame.js";

/**
 * The window a launch frame is read in.
 *
 * The wrapper opens the marker before it has anything to write, so the file
 * exists and is empty for as long as that takes. In a real run that is
 * microseconds against a 5ms poll, which is why it reached CI as a single
 * matrix leg failing once rather than as a test that does not work. Reproduced
 * here at the only width that makes it deterministic: the file is created, read
 * against, and completed afterwards.
 */
describe("reading a launch frame", () => {
  test("waits for a frame that exists before it has contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ltx-frame-"));
    try {
      const marker = join(directory, "launch.frame");
      // Exactly what `open(path, "wb")` leaves behind before its write lands.
      closeSync(openSync(marker, "w"));

      const reading = readLaunchFrame(marker, 10_000);
      // Long enough that a reader which returns on existence has certainly
      // returned, and returned the empty file.
      await new Promise((resolve) => setTimeout(resolve, 120));
      await writeFile(marker, `4242\n/tmp/ltx.sock\t9191\n`);

      expect(await reading).toEqual({
        daemonPid: 9191,
        socketPath: "/tmp/ltx.sock",
        wrapperPid: 4242,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test("waits through a frame written one line at a time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ltx-frame-partial-"));
    try {
      const marker = join(directory, "launch.frame");
      // The pid line alone parses as a pid and nothing else. Taken as whole it
      // gives `daemonPid` of NaN, which `kill` rejects with a type error rather
      // than anything naming this file.
      await writeFile(marker, "4242\n");

      const reading = readLaunchFrame(marker, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await writeFile(marker, `4242\n/tmp/ltx.sock\t9191\n`);

      expect((await reading).daemonPid).toBe(9191);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test("says which file never became whole, and shows what it held", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ltx-frame-never-"));
    try {
      const marker = join(directory, "launch.frame");
      await writeFile(marker, "0\n");
      // A pid of 0 is the value that used to pass for a live process, because
      // `kill(0, 0)` signals the caller's own group and succeeds.
      await expect(readLaunchFrame(marker, 200)).rejects.toThrow(/never became whole/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
