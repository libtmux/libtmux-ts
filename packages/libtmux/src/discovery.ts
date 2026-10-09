import { lstat, opendir } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { AbortLike } from "./types.js";
import { Server, type ServerOptions } from "./server.js";
import type { DaemonIdentity } from "./server.js";
import { TmuxCommandError, TmuxTransportError } from "./errors.js";
import { runtimeForServer } from "./_internal/runtime/context.js";
import { prepareCommandRequest, adaptRawResult } from "./_internal/operations/request.js";
import { tmuxContextSocket } from "./_internal/runtime/endpoint.js";

/** One directly probed local endpoint; aliases of one socket appear in diagnostics. */
export interface DiscoveredServer {
  readonly server: Server;
  readonly socketPath: string;
  readonly daemon: DaemonIdentity;
}

/** A failed root/probe remains distinguishable from an empty directory. */
export interface DiscoveryDiagnostic {
  readonly path: string;
  readonly kind: "root" | "probe" | "symlink" | "not_socket" | "duplicate";
  readonly error?: unknown;
}

/** Bounds cover entries, probes, roots and elapsed time; discovery never starts a daemon. */
export interface DiscoverServersOptions {
  /** Direct socket directories, not recursive search trees. Components retain filesystem meaning. */
  readonly roots?: readonly string[];
  /** Add /tmp/tmux-UID, TMUX_TMPDIR/tmux-UID and the selected configured endpoint's directory. */
  readonly includeDefaultRoots?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly tmuxBin?: string;
  readonly maxRoots?: number;
  readonly maxEntries?: number;
  readonly maxProbes?: number;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly signal?: AbortLike;
}

/** Completed observations only; `truncated` lists the bounds that stopped the search. */
export interface DiscoveryResult {
  readonly servers: readonly DiscoveredServer[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly truncated: readonly ("roots" | "entries" | "probes" | "deadline" | "cancelled")[];
  readonly entries: number;
  readonly probes: number;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new TypeError(`${name} must be a positive timer-safe integer`);
  return value;
}

function appendPath(root: string, name: string): string {
  return `${root.endsWith("/") ? root : `${root}/`}${name}`;
}
function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/**
 * Search bounded local socket directories, returning successes and diagnostics. Root symlinks
 * follow filesystem traversal; symlink entries are skipped. Hard-link aliases are reported once
 * by device/inode. Stale sockets produce probe diagnostics. This is not a machine-wide inventory.
 * A deadline aborts active probes and stops new work; an outstanding filesystem call may finish
 * later, at which point its directory handle closes. The returned result never changes.
 *
 * ```ts
 * import { discoverServers } from "libtmux";
 * const result = await discoverServers({ maxEntries: 64, maxProbes: 8, timeoutMs: 500 });
 * console.log(
 *   result.servers.map((found) => found.socketPath),
 *   result.diagnostics,
 *   result.truncated,
 * );
 * ```
 */
export async function discoverServers(
  options: DiscoverServersOptions = {},
): Promise<DiscoveryResult> {
  const maxRoots = positive("maxRoots", options.maxRoots ?? 16);
  const maxEntries = positive("maxEntries", options.maxEntries ?? 256);
  const maxProbes = positive("maxProbes", options.maxProbes ?? 32);
  const timeoutMs = positive("timeoutMs", options.timeoutMs ?? 2_000);
  const probeTimeoutMs = positive("probeTimeoutMs", options.probeTimeoutMs ?? 250);
  const tmuxBin = options.tmuxBin;
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const roots = [...(options.roots ?? [])];
  const diagnostics: DiscoveryDiagnostic[] = [];
  if (options.includeDefaultRoots !== false) {
    const uid = process.getuid?.();
    if (uid === undefined) throw new TypeError("default discovery roots require a Unix user ID");
    roots.push(`/tmp/tmux-${String(uid)}`);
    if (environment.TMUX_TMPDIR)
      roots.push(appendPath(environment.TMUX_TMPDIR, `tmux-${String(uid)}`));
    try {
      if (environment.LIBTMUX_SOCKET_PATH) {
        if (
          !isAbsolute(environment.LIBTMUX_SOCKET_PATH) ||
          environment.LIBTMUX_SOCKET_PATH.includes("\0")
        )
          throw new TypeError("LIBTMUX_SOCKET_PATH must be absolute without NUL");
        roots.push(parentPath(environment.LIBTMUX_SOCKET_PATH));
      } else if (!environment.LIBTMUX_SOCKET_NAME && environment.TMUX)
        roots.push(parentPath(tmuxContextSocket(environment.TMUX)));
    } catch (error) {
      diagnostics.push(Object.freeze({ path: "TMUX", kind: "root", error }));
    }
  }
  const uniqueRoots = [...new Set(roots)];
  const servers: DiscoveredServer[] = [];
  const truncated = new Set<DiscoveryResult["truncated"][number]>();
  if (uniqueRoots.length > maxRoots) truncated.add("roots");
  const seen = new Set<string>();
  let entries = 0;
  let probes = 0;
  const controller = new AbortController();
  let finish: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (reason: "deadline" | "cancelled"): void => {
    truncated.add(reason);
    controller.abort();
    finish();
  };
  const onAbort = (): void => stop("cancelled");
  const timer = setTimeout(() => stop("deadline"), timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();

  const scan = async (): Promise<void> => {
    for (const root of uniqueRoots.slice(0, maxRoots)) {
      if (controller.signal.aborted) return;
      if (!isAbsolute(root) || root.includes("\0")) {
        diagnostics.push(
          Object.freeze({
            path: root,
            kind: "root",
            error: new TypeError("discovery root must be absolute without NUL"),
          }),
        );
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Roots share one bounded entry/probe budget.
        const directory = await opendir(root, { bufferSize: 1 });
        try {
          while (!controller.signal.aborted) {
            if (entries >= maxEntries) {
              truncated.add("entries");
              return;
            }
            // eslint-disable-next-line no-await-in-loop -- Read one entry at a time to enforce the memory bound.
            const entry = await directory.read();
            if (entry === null || controller.signal.aborted) break;
            entries += 1;
            const path = appendPath(root, entry.name);
            try {
              // Deno 2.9's node:fs Dirent does not identify sockets; lstat also avoids following aliases.
              // eslint-disable-next-line no-await-in-loop -- An inode check precedes each bounded probe.
              const stat = await lstat(path, { bigint: true });
              if (controller.signal.aborted) return;
              if (!stat.isSocket()) {
                diagnostics.push(
                  Object.freeze({ path, kind: stat.isSymbolicLink() ? "symlink" : "not_socket" }),
                );
                continue;
              }
              const identity = `${String(stat.dev)}:${String(stat.ino)}`;
              if (seen.has(identity)) {
                diagnostics.push(Object.freeze({ path, kind: "duplicate" }));
                continue;
              }
              if (probes >= maxProbes) {
                truncated.add("probes");
                return;
              }
              seen.add(identity);
              probes += 1;
              const serverOptions: ServerOptions = {
                socketPath: path,
                environment,
                ...(tmuxBin === undefined ? {} : { tmuxBin }),
              };
              const server = new Server(serverOptions);
              const runtime = runtimeForServer(server);
              const args = ["display-message", "-p", "#{pid}\t#{start_time}"];
              const request = prepareCommandRequest(runtime.connection, args, {
                signal: controller.signal,
                timeoutMs: probeTimeoutMs,
              });
              const result = adaptRawResult(
                // eslint-disable-next-line no-await-in-loop -- The total probe budget and deadline apply serially.
                await runtime.transport.execute({
                  ...request,
                  globalArgs: ["-N", ...request.globalArgs],
                }),
              );
              if (controller.signal.aborted) return;
              if (result.exitCode !== 0)
                throw new TmuxCommandError({
                  args,
                  exitCode: result.exitCode,
                  stderr: result.stderr,
                  stdout: result.stdout,
                });
              const [pid, startTime, ...extra] = (result.stdout[0] ?? "").split("\t");
              if (
                result.stdout.length !== 1 ||
                extra.length > 0 ||
                pid === undefined ||
                startTime === undefined ||
                !/^[0-9]+$/u.test(pid) ||
                /^0+$/u.test(pid) ||
                !/^[0-9]+$/u.test(startTime)
              ) {
                throw new TmuxTransportError("discovery returned an invalid daemon identity", {
                  delivery: "replied",
                  kind: "protocol",
                });
              }
              servers.push(
                Object.freeze({
                  server,
                  socketPath: path,
                  daemon: Object.freeze({ pid, startTime }),
                }),
              );
            } catch (error) {
              if (!controller.signal.aborted)
                diagnostics.push(Object.freeze({ path, kind: "probe", error }));
            }
          }
        } finally {
          // eslint-disable-next-line no-await-in-loop -- Close this root before opening the next one.
          await directory.close();
        }
      } catch (error) {
        if (!controller.signal.aborted)
          diagnostics.push(Object.freeze({ path: root, kind: "root", error }));
      }
    }
  };
  try {
    await Promise.race([scan(), stopped]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  return Object.freeze({
    servers: Object.freeze([...servers]),
    diagnostics: Object.freeze([...diagnostics]),
    truncated: Object.freeze([...truncated]),
    entries,
    probes,
  });
}
