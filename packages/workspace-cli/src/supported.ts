import { assertSupportedTmux, TmuxCommandError, type Server } from "libtmux";

import type { CLIContext } from "./app.ts";
import { CliError } from "./output.ts";
import { processRun } from "./process.ts";

/** A daemon is not listening: the failure `list-sessions` gives with no server. */
function noDaemon(error: unknown): boolean {
  return (
    error instanceof TmuxCommandError &&
    error.exitCode === 1 &&
    error.stderr.length === 1 &&
    /^(?:no server running on .+|error connecting to .+ \((?:No such file or directory|Connection refused)\))$/u.test(
      error.stderr[0]!,
    )
  );
}

/**
 * Refuse a tmux below the supported minimum before a child process uses it.
 *
 * A live daemon is judged by its own version. With no daemon, the executable
 * `server` would run is asked for `-V`, which starts nothing, so neither an
 * unsupported tmux nor a supported one leaves a daemon behind or reads the
 * user's configuration.
 *
 * @throws VersionTooLowError when the daemon or the executable is too old.
 */
export async function requireSupportedTmux(
  server: Server,
  context: Pick<CLIContext, "cwd" | "env" | "signal">,
): Promise<void> {
  const { signal } = context;
  try {
    await server.cmd("list-sessions", [], signal ? { signal } : {});
    return;
  } catch (error) {
    if (!noDaemon(error)) throw error;
  }
  const probe = await processRun([server.tmuxBin, "-V"], {
    cwd: context.cwd,
    env: context.env,
    ...(signal ? { signal } : {}),
  });
  // The report is `<name> <version>`; 3.3a prints the executable's own name.
  const words = probe.stdout.trim().split(/\s+/u);
  if (probe.code !== 0 || words.length !== 2)
    throw new CliError("tmux_failed", `cannot establish the version of ${server.tmuxBin}`, 1);
  assertSupportedTmux(words[1]!);
}
