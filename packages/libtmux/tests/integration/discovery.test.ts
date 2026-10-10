import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer, type Socket } from "node:net";

import { expect, test } from "bun:test";

import { discoverServers } from "../../src/discovery.js";
import {
  makeTestDirectory,
  prepareRunRoot,
  reapOwnedRunRoot,
  runWithCleanup,
  TestServer,
} from "../../src/_internal/test/testkit.js";
import { waitForProcessExit } from "../support/converge.js";

async function withDiscoveryFixtures(
  body: (fixtures: readonly [TestServer, TestServer], directory: string) => Promise<void>,
): Promise<void> {
  const directory = await makeTestDirectory("ltx-discover-");
  const runRoot = join(directory, "run");
  await prepareRunRoot(runRoot);
  const fixtures: TestServer[] = [];
  let clean = false;
  try {
    await runWithCleanup(
      async () => {
        const first = await TestServer.create({ runRoot });
        fixtures.push(first);
        const second = await TestServer.create({ runRoot });
        fixtures.push(second);
        await body([first, second], directory);
      },
      async () => {
        await Promise.all(
          fixtures.map(async (fixture) => {
            await fixture.dispose();
            await waitForProcessExit(fixture.daemonIdentity.pid);
          }),
        );
        await reapOwnedRunRoot(runRoot);
        clean = true;
      },
    );
  } finally {
    if (clean) await rm(directory, { recursive: true, force: true });
  }
}

test("discovers two owned daemons across roots with aliases, stale sockets and diagnostics", async () => {
  await withDiscoveryFixtures(async ([first, second], directory) => {
    const extras = join(directory, "extras");
    await mkdir(extras);
    const staleSocket = join(extras, "stale");
    const temporarySocket = join(extras, "temporary");
    const fake = createServer();
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(temporarySocket, resolve);
    });
    await link(temporarySocket, staleSocket);
    await new Promise<void>((resolve, reject) =>
      fake.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await link(first.socketPath, join(extras, "alias"));
    await symlink(first.socketPath, join(extras, "symlink"));
    await writeFile(join(extras, "regular"), "not a socket");
    const result = await discoverServers({
      roots: [
        dirname(first.socketPath),
        dirname(second.socketPath),
        extras,
        join(directory, "absent"),
      ],
      includeDefaultRoots: false,
    });
    expect(new Set(result.servers.map((found) => found.daemon.pid))).toEqual(
      new Set([String(first.daemonIdentity.pid), String(second.daemonIdentity.pid)]),
    );
    expect(result.diagnostics.some((entry) => entry.kind === "duplicate")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.kind === "symlink")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.kind === "not_socket")).toBe(true);
    expect(
      result.diagnostics.some((entry) => entry.kind === "probe" && entry.path === staleSocket),
    ).toBe(true);
    expect(
      result.diagnostics.some((entry) => entry.kind === "root" && entry.path.endsWith("/absent")),
    ).toBe(true);
    expect(result.truncated).toEqual([]);
  });
}, 30_000);

test("entry, probe, root and deadline bounds expose truncation", async () => {
  await withDiscoveryFixtures(async ([first, second], directory) => {
    const roots = [dirname(first.socketPath), dirname(second.socketPath)];
    const probes = await discoverServers({ roots, includeDefaultRoots: false, maxProbes: 1 });
    expect(probes.probes).toBe(1);
    expect(probes.servers).toHaveLength(1);
    expect(probes.truncated).toContain("probes");
    const entries = await discoverServers({ roots, includeDefaultRoots: false, maxEntries: 1 });
    expect(entries.entries).toBe(1);
    expect(entries.truncated).toContain("entries");
    const rootBound = await discoverServers({ roots, includeDefaultRoots: false, maxRoots: 1 });
    expect(rootBound.servers).toHaveLength(1);
    expect(rootBound.truncated).toContain("roots");
    const slowRoot = join(directory, "slow");
    await mkdir(slowRoot);
    const connected = new Set<Socket>();
    const fake = createServer((socket) => {
      connected.add(socket);
      socket.on("close", () => connected.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(join(slowRoot, "socket"), resolve);
    });
    try {
      const timeout = await discoverServers({
        roots: [slowRoot],
        includeDefaultRoots: false,
        timeoutMs: 100,
        probeTimeoutMs: 2_000,
      });
      expect(timeout.truncated).toContain("deadline");
      expect(timeout.servers).toHaveLength(0);
      const failedProbe = await discoverServers({
        roots: [slowRoot],
        includeDefaultRoots: false,
        timeoutMs: 2_000,
        probeTimeoutMs: 50,
      });
      expect(failedProbe.diagnostics.some((entry) => entry.kind === "probe")).toBe(true);
      expect(failedProbe.truncated).toEqual([]);
    } finally {
      for (const socket of connected) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
}, 30_000);

test("root traversal retains missing components and symlink parent semantics", async () => {
  await withDiscoveryFixtures(async ([first], directory) => {
    const actualRoot = dirname(first.socketPath);
    const child = join(actualRoot, "child");
    await mkdir(child);
    const shortcut = join(directory, "shortcut");
    await symlink(child, shortcut);
    const selected = `${shortcut}/..`;
    try {
      const result = await discoverServers({
        roots: [`${actualRoot}/missing/..`, selected],
        includeDefaultRoots: false,
      });
      expect(result.servers.map((found) => found.daemon.pid)).toEqual([
        String(first.daemonIdentity.pid),
      ]);
      expect(result.servers[0]!.socketPath.startsWith(`${selected}/`)).toBe(true);
      expect(
        result.diagnostics.some(
          (entry) => entry.kind === "root" && entry.path.includes("/missing/.."),
        ),
      ).toBe(true);
    } finally {
      await rm(child, { recursive: true });
    }
  });
}, 30_000);

test("C-locale discovery preserves daemon identities and socket names", async () => {
  await withDiscoveryFixtures(async ([first, second], directory) => {
    const root = join(directory, "sockets; with space, comma");
    await mkdir(root);
    const firstPath = join(root, "first; socket, path");
    const secondPath = join(root, "second; socket, path");
    await link(first.socketPath, firstPath);
    await link(second.socketPath, secondPath);
    const result = await discoverServers({
      roots: [root],
      includeDefaultRoots: false,
      tmuxBin: first.tmuxExecutable,
      environment: { PATH: process.env.PATH, LC_ALL: "C", LANG: "C" },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.truncated).toEqual([]);
    expect(result.servers.map((found) => found.socketPath).toSorted()).toEqual(
      [firstPath, secondPath].toSorted(),
    );
    expect(result.servers.map((found) => found.daemon.pid).toSorted()).toEqual(
      [String(first.daemonIdentity.pid), String(second.daemonIdentity.pid)].toSorted(),
    );
    for (const found of result.servers) {
      expect(found.server.socketPath).toBe(found.socketPath);
      // eslint-disable-next-line no-await-in-loop -- Each endpoint is checked against its own probe receipt.
      expect(await found.server.daemonIdentity()).toEqual(found.daemon);
    }
  });
}, 30_000);
