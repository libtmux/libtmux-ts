import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";

const SCRIPT = new URL("../pidfd_reap.ts", import.meta.url).pathname;
const GENERATION = "LIBTMUX_PIDFD_TEST";

const children: Bun.Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** The daemon a reap record would describe, here a `sleep` that owns `GENERATION`. */
function sleeper(): { argv: string[]; identity: string; pid: number; process: Bun.Subprocess } {
  const argv = ["sleep", "60"];
  const process = Bun.spawn(argv, {
    env: { ...Bun.env, [GENERATION]: "owned" },
    stderr: "ignore",
    stdout: "ignore",
  });
  children.push(process);
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync(`/proc/${String(process.pid)}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  return { argv, identity: `linux:${boot}:${fields[19] ?? ""}`, pid: process.pid, process };
}

async function reap(
  pid: number,
  identity: string,
  comm: string,
  argv: string[],
  generationValue = "owned",
): Promise<{ code: number; report: unknown }> {
  const executable = realpathSync(`/proc/${String(pid)}/exe`);
  const child = Bun.spawn(
    [
      process.execPath,
      SCRIPT,
      String(pid),
      identity,
      comm,
      executable,
      JSON.stringify(argv),
      GENERATION,
      generationValue,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, report: stdout.trim() === "" ? undefined : JSON.parse(stdout) };
}

describe.skipIf(process.platform !== "linux")("pidfd_reap", () => {
  test("ends the daemon its arguments describe and says it was reaped", async () => {
    const daemon = sleeper();

    const result = await reap(daemon.pid, daemon.identity, "sleep", daemon.argv);

    expect(result).toEqual({ code: 0, report: { escalated: false, status: "reaped" } });
    await daemon.process.exited;
    expect(daemon.process.signalCode).toBe("SIGTERM");
  });

  test("leaves a process alone when what it describes is not what is running", async () => {
    const daemon = sleeper();

    const result = await reap(daemon.pid, daemon.identity, "sleep", daemon.argv, "someone-else");

    expect(result).toEqual({ code: 3, report: { status: "identity-mismatch" } });
    expect(daemon.process.exitCode).toBeNull();
    expect(daemon.process.signalCode).toBeNull();
  });

  test("refuses to start without all seven arguments", async () => {
    const child = Bun.spawn([process.execPath, SCRIPT, "1"], { stderr: "pipe", stdout: "ignore" });

    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("usage: pidfd_reap.ts");
  });
});
