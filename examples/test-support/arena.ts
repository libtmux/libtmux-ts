// Shared arena wiring for every per-example artifact.
//
// One artifact id per example (see each example's test file). The docs
// arena's supervisor treats LIBTMUX_ARENA_DESCRIPTOR as the sole activation
// signal; LIBTMUX_ARENA_ARTIFACT then has to name exactly the artifact this
// process implements, so one example's adapter can never silently answer
// for another's.

import { Server } from "../../packages/libtmux/src/server.js";

export type ArenaRoute =
  | { readonly kind: "fixture" }
  | { readonly kind: "arena"; readonly socketPath: string; readonly tmuxBin: string };

/** Decide whether this process is running under the docs arena, for `artifact`. */
export function arenaRoute(
  artifact: string,
  environment: Readonly<Record<string, string | undefined>>,
): ArenaRoute {
  if (
    environment.LIBTMUX_ARENA_DESCRIPTOR === undefined ||
    environment.LIBTMUX_ARENA_DESCRIPTOR === ""
  ) {
    return { kind: "fixture" };
  }
  const actualArtifact = environment.LIBTMUX_ARENA_ARTIFACT;
  const socketPath = environment.LIBTMUX_SOCKET_PATH;
  const tmuxBin = environment.LIBTMUX_TMUX_BIN;
  if (
    actualArtifact === undefined ||
    actualArtifact === "" ||
    socketPath === undefined ||
    socketPath === "" ||
    tmuxBin === undefined ||
    tmuxBin === ""
  ) {
    throw new Error("arena contract is incomplete");
  }
  if (actualArtifact !== artifact) {
    throw new Error(`arena artifact does not select ${artifact}`);
  }
  return { kind: "arena", socketPath, tmuxBin };
}

/** The production `Server` the arena lent, or `undefined` off the fixture path. */
export function arenaServer(
  route: ArenaRoute,
  environment: Readonly<Record<string, string | undefined>>,
): Server | undefined {
  if (route.kind === "fixture") return undefined;
  return new Server({ environment, socketPath: route.socketPath, tmuxBin: route.tmuxBin });
}

/** The one `LIBTMUX_ARENA_EVIDENCE` line the docs-arena supervisor requires. */
export async function arenaEvidence(
  artifact: string,
  server: Server,
  socketPath: string,
): Promise<string> {
  const identity = await server.daemonIdentity();
  if (identity === undefined) throw new Error("arena server did not report its identity");
  const [actualSocketPath] = await server.cmd("display-message", ["-p", "#{socket_path}"]);
  const [challenge] = await server.cmd("display-message", ["-p", "#{@libtmux_arena_challenge}"]);
  const serverPid = Number(identity.pid);
  if (!Number.isSafeInteger(serverPid) || serverPid < 1) {
    throw new Error("arena server reported an invalid pid");
  }
  if (actualSocketPath !== socketPath) {
    throw new Error("arena socket does not match requested endpoint");
  }
  if (challenge === undefined || challenge === "") throw new Error("arena challenge is empty");
  return JSON.stringify({
    artifact,
    challenge,
    schema: 1,
    server_pid: serverPid,
    socket_path: actualSocketPath,
  });
}

/**
 * Undo whatever an earlier run against this same live server left behind.
 *
 * The docs arena mints one fresh server per artifact run and then destroys
 * it, so in that harness this never has anything to do. But every quoted
 * example creates its sessions under a fixed, un-namespaced name — that is
 * the example, and it is not this helper's place to change it — so a second
 * run against a still-warm endpoint (a person re-running the test file by
 * hand, or a future arena mode that shares one server across examples)
 * would otherwise die on tmux's "duplicate session" rather than on anything
 * the example teaches. This clears exactly the named sessions the example
 * is about to recreate, through the production snapshot/kill API, and
 * nothing else — it never touches the server itself, which the arena
 * contract forbids regardless.
 */
export async function arenaReset(server: Server, sessionNames: readonly string[]): Promise<void> {
  const snapshot = await server.snapshot();
  for (const name of sessionNames) {
    const found = snapshot.sessions.first({ name });
    // eslint-disable-next-line no-await-in-loop -- a handful of names, killed in order.
    if (found !== undefined) await found.kill().catch(() => undefined);
  }
}
