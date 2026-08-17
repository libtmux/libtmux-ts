import { readFile } from "node:fs/promises";

export interface LaunchFrame {
  readonly daemonPid: number;
  readonly socketPath: string;
  readonly wrapperPid: number;
}

/**
 * The launch frame, once it is whole rather than merely present.
 *
 * The wrapper opens the marker for writing before it has anything to write, and
 * `open(path, "wb")` creates the file at that moment — so a reader that waits
 * for the path can read an empty one. What made that worth a helper is how
 * quietly it goes wrong: `Number("")` is 0, `kill(0, 0)` signals the caller's
 * own process group and succeeds, so a zero pid reads as a live process and the
 * mistake surfaces later as something else. `readMarker` already polls its JSON
 * until it parses; this is the same rule for the frame the wrapper writes.
 */
export async function readLaunchFrame(path: string, timeoutMs = 30_000): Promise<LaunchFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling is sequential by nature.
    const text = await readFile(path, "utf8").catch(() => "");
    const [rawWrapperPid, frame] = text.trim().split("\n");
    const [socketPath, rawDaemonPid] = frame?.split("\t") ?? [];
    const wrapperPid = Number(rawWrapperPid);
    const daemonPid = Number(rawDaemonPid);
    if (
      socketPath !== undefined &&
      socketPath !== "" &&
      Number.isSafeInteger(wrapperPid) &&
      wrapperPid > 0 &&
      Number.isSafeInteger(daemonPid) &&
      daemonPid > 0
    ) {
      return { daemonPid, socketPath, wrapperPid };
    }
    if (Date.now() > deadline) {
      throw new Error(`launch frame never became whole: ${path} (${JSON.stringify(text)})`);
    }
    // eslint-disable-next-line no-await-in-loop -- each wait follows the probe before it.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
