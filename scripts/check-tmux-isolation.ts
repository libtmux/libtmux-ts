/**
 * Run a command as it runs from a shell inside tmux, and fail when it reaches a
 * tmux server it did not start.
 *
 * The command inherits `TMUX` and `TMUX_PANE` naming a decoy server started here
 * with `-vv`, and `TMUX_TMPDIR` at an empty directory. A client that names no
 * socket follows `TMUX` to the decoy, whose log records it; one that names a
 * socket with `-L` resolves it under `TMUX_TMPDIR`. Either fails the run, and so
 * does a decoy the command killed. Both detectors fire once before the command
 * starts, so a pass means the command touched neither.
 *
 * A failure names the commands the decoy saw and counts sockets, and never
 * prints a value from the environment the command gets. The decoy's `-vv` log
 * records each client's environment; it stays in this run's private directory
 * and goes with it.
 *
 *     bun scripts/check-tmux-isolation.ts bun run test:docs
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = process.argv.slice(2);
if (command.length === 0) {
  process.stderr.write("usage: bun scripts/check-tmux-isolation.ts <command> [argument...]\n");
  process.exit(2);
}

const tmux = process.env["LIBTMUX_TMUX_BIN"] ?? "tmux";
const without = (...names: string[]): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !names.includes(entry[0]),
    ),
  );
// The decoy is a server of its own, never a client nested in the caller's tmux.
const outside = without("TMUX", "TMUX_PANE");

const base = await mkdtemp(join(tmpdir(), "ltx-tmux-isolation-"));
const decoy = join(base, "decoy");
const sandbox = join(base, "tmpdir");
// tmux makes this directory only to resolve a socket by name; an -S path never does.
const named = join(sandbox, `tmux-${String(process.getuid?.() ?? 0)}`);
await mkdir(sandbox);

const ask = (...args: string[]): string => {
  const result = spawnSync(tmux, ["-S", decoy, ...args], { encoding: "utf8", env: outside });
  if (result.status !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};
const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const problems: string[] = [];
let code = 1;
try {
  // -vv writes the server's log to its working directory.
  spawnSync(
    tmux,
    ["-vv", "-f", "/dev/null", "-S", decoy, "new-session", "-d", "-s", "decoy", "sleep 86400"],
    { cwd: base, env: outside },
  );
  const pid = ask("display-message", "-p", "#{pid}");
  const pane = ask("display-message", "-p", "#{pane_id}");
  const log = join(base, `tmux-server-${pid}.log`);
  const read = async (): Promise<string[]> => (await readFile(log, "utf8")).split("\n");
  const inside = {
    ...without("TMUX", "TMUX_PANE", "TMUX_TMPDIR"),
    TMUX: `${decoy},${pid},0`,
    TMUX_PANE: pane,
    TMUX_TMPDIR: sandbox,
  };

  // Each detector has to fire once before its silence can mean anything.
  const clients = async (): Promise<number> =>
    (await read()).filter((line) => line.includes(" new client ")).length;
  const before = await clients();
  spawnSync(tmux, ["list-sessions"], { env: inside, stdio: "ignore" });
  if ((await clients()) === before)
    throw new Error("the decoy logged no client for a bare `tmux list-sessions`");
  spawnSync(tmux, ["-L", "isolation-probe", "list-sessions"], { env: inside, stdio: "ignore" });
  if (!(await exists(named))) throw new Error("`tmux -L` made nothing under TMUX_TMPDIR");
  await rm(named, { force: true, recursive: true });

  const mark = (await read()).length;
  code = await Bun.spawn(command, { env: inside, stdio: ["inherit", "inherit", "inherit"] }).exited;

  const during = (await read()).slice(mark);
  const reached = during.filter((line) => line.includes(" new client ")).length;
  if (reached > 0) {
    const sent = during.flatMap(
      (line) => /cmdq_fire_command <client-\d+>: \(\d+\) (\S+)/u.exec(line)?.[1] ?? [],
    );
    problems.push(
      `it reached the server TMUX names ${String(reached)} times, sending: ${[...new Set(sent)].join(", ") || "nothing"}`,
    );
  }
  if (spawnSync(tmux, ["-S", decoy, "has-session", "-t", "decoy"], { env: outside }).status !== 0) {
    problems.push("the server TMUX names did not survive it");
  }
  if (await exists(named)) {
    // A count, not the names: a name can come from a variable the caller set.
    const left = (await readdir(named)).length;
    problems.push(
      `it resolved a tmux socket by name under TMUX_TMPDIR (${String(left)} still there)`,
    );
  }
} catch (error) {
  problems.push(`the isolation check could not run: ${(error as Error).message}`);
} finally {
  // A server the command started by name outlives its socket's directory unless stopped.
  const leftovers = (await exists(named)) ? await readdir(named) : [];
  for (const socket of [decoy, ...leftovers.map((name) => join(named, name))]) {
    spawnSync(tmux, ["-S", socket, "kill-server"], { env: outside, stdio: "ignore" });
  }
  await rm(base, { force: true, recursive: true });
}

if (problems.length > 0) {
  process.stderr.write(
    `\n${command.join(" ")} is not isolated from the tmux it runs inside:\n${problems.map((each) => `- ${each}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.exit(code);
