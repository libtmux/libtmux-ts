import { Server, TmuxServerRestarted } from "libtmux";
import { flattenInvocation, guardRequest } from "libtmux/engine";
import type { TmuxCommandResult, TmuxEngine, TmuxInvocationRequest } from "libtmux/engine";

/**
 * Reach tmux through an engine you supply, rather than the built-in transports.
 *
 * Everything above the engine — capabilities, snapshots, the graph, queries,
 * mutations — is built on one structured invocation. Replace that operation
 * and the whole library follows to wherever your `run` reaches tmux: over SSH,
 * inside a container, or behind a daemon. This example keeps `run` local so
 * the point is only the seam: nothing above it knows the difference.
 *
 * The request already contains one structured command list, and `guardRequest`
 * lets tmux refuse it when it addresses a daemon that has since restarted.
 */
export async function throughACustomEngine(reference: Server): Promise<number> {
  const tmuxBin = reference.tmuxBin;
  const socketPath = reference.socketPath;
  if (socketPath === undefined) throw new Error("this example needs a socket-path server");

  const run = async (request: TmuxInvocationRequest): Promise<TmuxCommandResult> => {
    const argv = [request.executable, ...flattenInvocation(request)];
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();

    try {
      const child = Bun.spawn([tmuxBin, "-S", socketPath, ...argv.slice(1)], {
        ...(request.environment === undefined ? {} : { env: request.environment }),
        signal: controller.signal,
        stderr: "pipe",
        stdout: "pipe",
        stdin: request.stdin === undefined ? "ignore" : "pipe",
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      });
      if (request.stdin !== undefined && child.stdin !== undefined) {
        await child.stdin.write(request.stdin);
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
        signal: child.signalCode,
        stderr: new Uint8Array(stderr),
        stdout: new Uint8Array(stdout),
      };
    } finally {
      request.signal?.removeEventListener("abort", abort);
    }
  };

  const engine: TmuxEngine = {
    endpoint: `local://${socketPath}`,
    async execute(request) {
      const guarded = guardRequest(request);
      const result = await run(guarded.request);
      if (guarded.refusedBy(result.returncode, result.stderr)) {
        throw new TmuxServerRestarted("the daemon this handle was read from is gone");
      }
      return result;
    },
  };

  const throughEngine = new Server({ engine });

  // The whole API works over the seam. A snapshot's identity read and four
  // listings arrive in one request, and they describe the same tmux the
  // built-in server sees.
  const snapshot = await throughEngine.snapshot();
  return snapshot.sessions.count();
}
