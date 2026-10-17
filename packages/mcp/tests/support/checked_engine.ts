import type { TmuxCommandResult, TmuxEngine, TmuxInvocationRequest } from "libtmux/engine";

const PROBE = /^(libtmux-version-[0-9a-f]{32}-)#\{version\}\/#\{pid\}\/#\{start_time\}$/u;

/**
 * An engine for a `Server` under test.
 *
 * A `Server` reads the daemon's version through its engine before the first
 * command and starts each list with a version fence. This answers the first
 * and hands `handler` each list as the caller wrote it.
 */
export function checkedEngine(
  handler: (request: TmuxInvocationRequest) => Promise<TmuxCommandResult>,
  version = "3.7d",
): TmuxEngine {
  return {
    execute(request) {
      const [first, ...rest] = request.commands;
      const marker = PROBE.exec(first[2] ?? "")?.[1];
      if (first[0] === "run-shell" && first[1] === "-C" && marker !== undefined) {
        return Promise.resolve({
          cmd: [],
          exitCode: 1,
          signal: null,
          stderr: new TextEncoder().encode(`unknown command: ${marker}${version}/101/202\n`),
          stdout: new Uint8Array(),
        });
      }
      const fenced =
        first[0] === "if-shell" &&
        first[1] === "-F" &&
        first[3] === "" &&
        /^libtmux-version-[0-9a-f]{32}$/u.test(first[4] ?? "");
      const [next, ...others] = rest;
      if (!fenced || next === undefined) return handler(request);
      const flags =
        request.globalArgs.at(-1) === "-N" ? request.globalArgs.slice(0, -1) : request.globalArgs;
      return handler({ ...request, commands: [next, ...others], globalArgs: flags });
    },
  };
}
