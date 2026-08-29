import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { killIfRunning, processExists } from "../support/converge.js";
import { runBoundedCommand } from "../../../../scripts/bounded_process.js";
import { makeTestDirectory } from "../../src/_internal/test/testkit.js";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const boundedProcessUrl = new URL("../../../../scripts/bounded_process.ts", import.meta.url).href;
const coreInstallCheck = fileURLToPath(new URL("../../scripts/check-install.ts", import.meta.url));
const consumerInstallCheck = fileURLToPath(
  new URL("../../../../scripts/check-consumer-install.ts", import.meta.url),
);

async function exitsWithin(pid: number, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (!processExists(pid)) return true;
    // eslint-disable-next-line no-await-in-loop -- process exit converges within one test bound.
    await Bun.sleep(5);
  }
  return !processExists(pid);
}

async function waitForPid(path: string): Promise<number> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- the marker makes child startup observable.
    const value = await readFile(path, "utf8").catch(() => "");
    if (/^[1-9]\d*$/u.test(value)) return Number(value);
    // eslint-disable-next-line no-await-in-loop -- marker polling is sequential and bounded.
    await Bun.sleep(5);
  }
  throw new Error("bounded-command child did not publish its PID");
}

describe("bounded subprocesses", () => {
  test("accept an exact aggregate output limit and close stdin", async () => {
    const input = "from-stdin";
    const result = await runBoundedCommand(
      [
        process.execPath,
        "-e",
        'const input = await Bun.stdin.text(); process.stdout.write(input); process.stderr.write("!");',
      ],
      {
        env: { ...process.env },
        maxOutputBytes: Buffer.byteLength(input) + 1,
        stdin: input,
        timeoutMilliseconds: 1_000,
      },
    );

    expect(result.termination).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toBe("!");
  });

  test("stops when stdout and stderr exceed one aggregate limit", async () => {
    const maxOutputBytes = 128;
    const result = await runBoundedCommand(
      [
        process.execPath,
        "-e",
        `process.stdout.write("o".repeat(${String(maxOutputBytes)})); ` +
          'process.stderr.write("e"); await Bun.sleep(60_000);',
      ],
      {
        env: { ...process.env },
        maxOutputBytes,
        timeoutMilliseconds: 1_000,
      },
    );

    expect(result.termination).toBe("output_limit_exceeded");
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      maxOutputBytes,
    );
  });

  test.skipIf(process.platform === "win32")(
    "contains a child that closes stdin before reading it",
    async () => {
      const result = await runBoundedCommand(["sh", "-c", "exec 0<&-; sleep 60"], {
        env: { ...process.env },
        maxOutputBytes: 1_024,
        stdin: "x".repeat(8 * 1024 * 1024),
        timeoutMilliseconds: 250,
      });

      expect(result.termination).toBe("timed_out");
      expect(result.exitCode).not.toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "reaps its process group after a successful parent exits",
    async () => {
      let descendantPid = 0;
      try {
        const result = await runBoundedCommand(
          ["sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!"],
          {
            env: { ...process.env },
            maxOutputBytes: 1_024,
            timeoutMilliseconds: 1_000,
          },
        );
        descendantPid = Number(result.stdout.trim());

        expect(result.termination).toBe("exited");
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        expect(await exitsWithin(descendantPid, 1_000)).toBe(true);
      } finally {
        if (descendantPid > 0) killIfRunning(descendantPid);
      }
    },
  );

  for (const [signal, exitCode] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test.skipIf(process.platform === "win32")(
      `reaps its process group when the checker receives ${signal}`,
      async () => {
        const root = await makeTestDirectory("ltx-bounded-signal-");
        const marker = join(root, "child.pid");
        const childSource = `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await Bun.sleep(60_000);`;
        const wrapperSource = `
        import { runBoundedCommand } from ${JSON.stringify(boundedProcessUrl)};
        await runBoundedCommand([process.execPath, "-e", ${JSON.stringify(childSource)}], {
          env: { ...process.env },
          maxOutputBytes: 1024,
          timeoutMilliseconds: 60_000,
        });
      `;
        const wrapper = Bun.spawn([process.execPath, "-e", wrapperSource], {
          env: { ...process.env },
          stderr: "ignore",
          stdout: "ignore",
        });
        let childPid = 0;

        try {
          childPid = await waitForPid(marker);
          wrapper.kill(signal);

          expect(await wrapper.exited).toBe(exitCode);
          expect(await exitsWithin(childPid, 1_000)).toBe(true);
        } finally {
          if (processExists(wrapper.pid)) killIfRunning(wrapper.pid);
          if (childPid > 0) killIfRunning(childPid);
          await rm(root, { force: true, recursive: true });
        }
      },
    );
  }

  test.skipIf(process.platform === "win32")(
    "does not redeliver a signal owned by the host",
    async () => {
      const root = await makeTestDirectory("ltx-bounded-signal-owner-");
      const marker = join(root, "child.pid");
      const report = join(root, "report.json");
      const childSource = `await Bun.write(${JSON.stringify(marker)}, String(process.pid)); await Bun.sleep(60_000);`;
      const wrapperSource = `
        import { runBoundedCommand } from ${JSON.stringify(boundedProcessUrl)};
        let deliveries = 0;
        process.once("SIGTERM", () => { deliveries += 1; });
        await runBoundedCommand([process.execPath, "-e", ${JSON.stringify(childSource)}], {
          env: { ...process.env },
          maxOutputBytes: 1024,
          timeoutMilliseconds: 60_000,
        });
        await Bun.write(${JSON.stringify(report)}, JSON.stringify({ deliveries }));
        process.exit(0);
      `;
      const wrapper = Bun.spawn([process.execPath, "-e", wrapperSource], {
        env: { ...process.env },
        stderr: "ignore",
        stdout: "ignore",
      });
      let childPid = 0;

      try {
        childPid = await waitForPid(marker);
        wrapper.kill("SIGTERM");

        expect(await exitsWithin(wrapper.pid, 1_000)).toBe(true);
        expect(await wrapper.exited).toBe(0);
        expect(JSON.parse(await readFile(report, "utf8"))).toEqual({ deliveries: 1 });
        expect(await exitsWithin(childPid, 1_000)).toBe(true);
      } finally {
        if (processExists(wrapper.pid)) killIfRunning(wrapper.pid);
        if (childPid > 0) killIfRunning(childPid);
        await rm(root, { force: true, recursive: true });
      }
    },
  );
});

describe("install-check cleanup", () => {
  test("keeps an argument failure to one line", async () => {
    const result = await runBoundedCommand([process.execPath, consumerInstallCheck], {
      cwd: repositoryRoot,
      env: { ...process.env },
      maxOutputBytes: 1_024,
      timeoutMilliseconds: 1_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "usage: bun scripts/check-consumer-install.ts <package-directory>\n",
    );
  });

  for (const [name, checker, arguments_] of [
    ["core", coreInstallCheck, []],
    ["workspace consumer", consumerInstallCheck, ["packages/workspace"]],
  ] as const) {
    test(`removes the ${name} project after an install failure`, async () => {
      const root = await makeTestDirectory("ltx-install-cleanup-");
      const temporary = join(root, "tmp");
      const binaries = join(root, "bin");
      const npm = Bun.which("npm");
      if (npm === null) throw new Error("npm is unavailable");
      await Promise.all([mkdir(temporary), mkdir(binaries)]);
      const shim = join(binaries, "npm");
      await writeFile(
        shim,
        [
          "#!/bin/sh",
          'if [ "$1" = install ]; then',
          '  echo "forced install failure" >&2',
          "  exit 23",
          "fi",
          'exec "$REAL_NPM" "$@"',
          "",
        ].join("\n"),
      );
      await chmod(shim, 0o755);

      try {
        const result = await runBoundedCommand([process.execPath, checker, ...arguments_], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PATH: `${binaries}${delimiter}${process.env.PATH ?? ""}`,
            REAL_NPM: npm,
            TMPDIR: temporary,
          },
          maxOutputBytes: 1024 * 1024,
          timeoutMilliseconds: 120_000,
        });

        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("forced install failure");
        expect(
          (await readdir(temporary)).filter(
            (entry) =>
              entry.startsWith("ltx-install-") || entry.startsWith("ltx-consumer-install-"),
          ),
        ).toEqual([]);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }, 150_000);
  }
});
