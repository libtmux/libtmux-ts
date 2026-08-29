import { Server } from "libtmux";
import { flattenInvocation, guardRequest } from "libtmux/engine";
import type { TmuxCommandResult, TmuxEngine } from "libtmux/engine";
import { TmuxServerRestarted } from "libtmux";

/**
 * Reach tmux through an engine you supply, rather than the built-in transports.
 *
 * Everything above the transport — capabilities, snapshots, the graph, queries,
 * mutations — is built on one operation: bytes in, bytes out. Replace that
 * operation and the whole library follows to wherever your `run` reaches tmux —
 * over ssh, inside a container, behind a daemon. This example keeps `run`
 * local, shelling to the same tmux the built-in server drives, so the point is
 * only the seam: nothing above it knows the difference.
 *
 * The request already contains one structured command list, and `guardRequest`
 * lets tmux refuse it when it addresses a daemon that has since restarted.
 */
export async function throughACustomEngine(reference: Server): Promise<number> {
  const tmuxBin = reference.tmuxBin;
  const socketPath = reference.socketPath;
  if (socketPath === undefined) throw new Error("this example needs a socket-path server");

  const run = async (
    argv: readonly string[],
    stdin: Uint8Array | undefined,
  ): Promise<TmuxCommandResult> => {
    const child = Bun.spawn([tmuxBin, "-S", socketPath, ...argv.slice(1)], {
      stderr: "pipe",
      stdout: "pipe",
      stdin: stdin === undefined ? "ignore" : "pipe",
    });
    if (stdin !== undefined && child.stdin !== undefined) {
      await child.stdin.write(stdin);
      await child.stdin.end();
    }
    const [returncode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
    ]);
    return {
      cmd: argv,
      returncode,
      signal: null,
      stderr: new Uint8Array(stderr),
      stdout: new Uint8Array(stdout),
    };
  };

  const engine: TmuxEngine = {
    endpoint: `local://${socketPath}`,
    async execute(request) {
      const guarded = guardRequest(request);
      const result = await run(
        [guarded.request.executable, ...flattenInvocation(guarded.request)],
        guarded.request.stdin,
      );
      if (guarded.refusedBy(result.returncode, result.stderr)) {
        throw new TmuxServerRestarted("the daemon this handle was read from is gone");
      }
      return result;
    },
  };

  const remote = new Server({ engine });

  // The whole API works over the seam. A snapshot's four commands arrive in
  // one request, and it answers about the same tmux the built-in server sees.
  const snapshot = await remote.snapshot();
  return snapshot.sessions.count();
}
