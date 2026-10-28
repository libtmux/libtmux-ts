// The lease a program run holds: tmux ends the program unless the caller keeps renewing it.
import { TmuxCommandError, TmuxObjectNotFoundError } from "../../errors.js";
import type { RuntimeContext } from "../runtime/context.js";
import { runCommands } from "./command.js";
import { readPane, type Owned } from "./program.js";

/** A lease tmux holds on the program; see {@link leaseTimer}. */
export interface Lease {
  readonly ms: number;
  token: number;
  renewing: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
}

/**
 * tmux's side of a lease: in `seconds`, unless renewed past `token`, SIGKILL the
 * program and remove its pane and files. `##` defers each read to that moment.
 */
export function leaseTimer(
  paneId: string,
  owned: Owned,
  keep: boolean,
  files: boolean,
  token: number,
  seconds: number,
): string[][] {
  const kill = "##{?pane_dead,:,kill -s KILL -- -##{pane_pid} 2>/dev/null}";
  const clear = files ? "(sleep 1; rm -rf -- ##{q:@libtmux-files}) >/dev/null 2>&1 &" : ":";
  // Targets are single-quoted: a window's `$N:=name` would otherwise read as a variable.
  const remove = keep ? "" : ` ; kill-${owned.kind} -t '${owned.target}'`;
  const expire = `if-shell -F -t '${paneId}' "##{==:##{@libtmux-lease},${String(token)}}" "run-shell -t '${paneId}' '${kill}; ${clear}'${remove}"`;
  // The timer first: a renewal that stops between the two leaves the last token's timer standing.
  return [
    ["run-shell", "-b", "-d", seconds.toFixed(3), "-C", expire],
    ["set-option", "-p", "-t", paneId, "@libtmux-lease", String(token)],
  ];
}

/** What a lease covers: the pane, and what its expiry removes. */
export interface LeaseTarget {
  readonly files: boolean;
  readonly keep: boolean;
  readonly owned: Owned;
  readonly paneId: string;
  readonly runtime: RuntimeContext;
  /** Stops the exit watch, which a pane removed from outside never ends. */
  readonly watcher: AbortController;
}

/** Move the lease on; a renewal still in flight is not overtaken, so tokens arrive in order. */
async function renew(target: LeaseTarget, lease: Lease): Promise<void> {
  if (lease.renewing) return;
  lease.renewing = true;
  lease.token += 1;
  const { files, keep, owned, paneId, runtime } = target;
  try {
    await runCommands(
      runtime,
      leaseTimer(paneId, owned, keep, files, lease.token, lease.ms / 1000),
    );
  } catch (error) {
    // A pane removed from outside has nothing left to lease; anything else is retried.
    const gone =
      error instanceof TmuxCommandError &&
      (await readPane(runtime, paneId, []).then(
        () => false,
        (failure: unknown) => failure instanceof TmuxObjectNotFoundError,
      ));
    if (gone) {
      clearInterval(lease.timer);
      target.watcher.abort();
    }
  } finally {
    lease.renewing = false;
  }
}

/**
 * Renew the lease every third of its length. Unreferenced, so the lease keeps
 * no process alive; the exit watch does, until the program ends.
 */
export function startRenewal(target: LeaseTarget, lease: Lease): void {
  lease.timer = setInterval(() => void renew(target, lease), lease.ms / 3);
  lease.timer.unref();
}
