import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import {
  beginFixtureLaunch,
  readFixtureRecord,
  type FixtureRecord,
} from "../../src/_internal/test/testkit.js";

interface ClosableServer {
  close(callback: () => void): unknown;
}

async function listenOnUnixSocket(socketPath: string): Promise<ClosableServer> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeNetServer(server: ClosableServer | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function journalIdentity(metadata: Awaited<ReturnType<typeof lstat>>) {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    kind: metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : metadata.isSocket()
          ? "socket"
          : "other",
    mode: String(metadata.mode),
    uid: String(metadata.uid),
  };
}

async function writeFixtureEscrowJournal(
  reserved: {
    readonly record: FixtureRecord;
    readonly recordPath: string;
    readonly reservationPath: string;
  },
  escrow: string,
  protocol: "libtmux-fixture-escrow-v2" | "libtmux-fixture-escrow-v3" = "libtmux-fixture-escrow-v3",
): Promise<void> {
  const recordText = await readFile(reserved.recordPath, "utf8");
  const socket = await lstat(reserved.record.socketPath).catch(() => undefined);
  await writeFile(
    join(escrow, "journal.json"),
    `${JSON.stringify({
      logicalSocketName: reserved.record.logicalSocketName,
      protocol,
      record: journalIdentity(await lstat(reserved.recordPath)),
      recordDigest: createHash("sha256").update(recordText).digest("hex"),
      recordPath: reserved.recordPath,
      ...(protocol === "libtmux-fixture-escrow-v3" ? { recordSnapshot: reserved.record } : {}),
      reservation: journalIdentity(await lstat(reserved.reservationPath)),
      reservationPath: reserved.reservationPath,
      runId: reserved.record.runId,
      ...(socket === undefined ? {} : { socket: journalIdentity(socket) }),
      socketPath: reserved.record.socketPath,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function syntheticLaunchInput(record: Extract<FixtureRecord, { readonly phase: "reserved" }>) {
  const value = randomUUID();
  const generation = {
    name: `LIBTMUX_TEST_GENERATION_${value.replaceAll("-", "").toUpperCase()}`,
    value,
  };
  const readyChannel = `ready-${randomUUID()}`;
  const paneCommand = [
    "env",
    "-u",
    shellQuote(generation.name),
    shellQuote(record.controller.executablePath),
    "-N",
    "-S",
    shellQuote(record.socketPath),
    "wait-for",
    "-S",
    shellQuote(readyChannel),
    "&&",
    "exec",
    "cat",
  ].join(" ");
  const bootstrapArgv = [
    record.controller.executablePath,
    "-f",
    "/dev/null",
    "-S",
    record.socketPath,
    "start-server",
    ";",
    "if-shell",
    "-F",
    `#{==:#{${generation.name}},${generation.value}}`,
    `new-session -d -P -F '#{socket_path}\t#{pid}\t#{session_id}' -s 'fixture-synthetic' ${shellQuote(paneCommand)}`,
    `display-message -p 'generation-mismatch-${randomUUID()}'`,
  ] as const;
  return { bootstrapArgv, generation };
}

async function beginSyntheticLaunch(reserved: {
  readonly capability: Parameters<typeof beginFixtureLaunch>[0];
  readonly record: Extract<FixtureRecord, { readonly phase: "reserved" }>;
  readonly reservationPath: string;
}) {
  const launch = syntheticLaunchInput(reserved.record);
  const attempt = await beginFixtureLaunch(reserved.capability, launch);
  const record = await readFixtureRecord(reserved.reservationPath);
  if (record.phase !== "launching") throw new Error("synthetic launch did not persist launching");
  return { attempt, record };
}

export {
  beginSyntheticLaunch,
  closeNetServer,
  journalIdentity,
  listenOnUnixSocket,
  syntheticLaunchInput,
  writeFixtureEscrowJournal,
};
export type { ClosableServer };
