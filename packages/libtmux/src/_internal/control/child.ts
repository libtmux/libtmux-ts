import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Callbacks owned by one control-mode child process. */
export interface ControlChildListeners {
  readonly close: (code: number | null) => void;
  readonly error: (error: Error) => void;
  readonly stderr: (chunk: Buffer) => void;
  readonly stdinDrain: () => void;
  readonly stdinError: () => void;
  readonly stdout: (chunk: Buffer) => void;
}

interface ActiveChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly listeners: ControlChildListeners;
}

export interface ControlChildLifecycleOptions {
  readonly terminationGraceMs?: number;
}

/**
 * Own one control-mode child at a time.
 *
 * Retirement removes every stateful callback before signalling the process,
 * so a late read, write failure, error, or close cannot act on its successor.
 */
export class ControlChildLifecycle {
  #active: ActiveChild | undefined;
  readonly #spawn: () => ChildProcessWithoutNullStreams;
  readonly #terminationGraceMs: number;

  constructor(
    spawn: () => ChildProcessWithoutNullStreams,
    options: ControlChildLifecycleOptions = {},
  ) {
    this.#spawn = spawn;
    this.#terminationGraceMs = options.terminationGraceMs ?? 2_000;
  }

  active(): ChildProcessWithoutNullStreams | undefined {
    return this.#active?.child;
  }

  open(listeners: ControlChildListeners): ChildProcessWithoutNullStreams {
    if (this.#active !== undefined) {
      throw new Error("the active control child must be retired before it is replaced");
    }
    const child = this.#spawn();
    this.#active = { child, listeners };
    child.stdout.on("data", listeners.stdout);
    child.stderr.on("data", listeners.stderr);
    child.stdin.on("drain", listeners.stdinDrain);
    child.stdin.on("error", listeners.stdinError);
    child.on("error", listeners.error);
    child.on("close", listeners.close);
    return child;
  }

  write(line: string, failed: (error: Error) => void): boolean {
    const active = this.#active;
    if (active === undefined) return false;
    return active.child.stdin.write(line, (error) => {
      if (error !== null && error !== undefined && this.#active === active) failed(error);
    });
  }

  /** Retire the active generation once and return the process that was owned. */
  retire(): ChildProcessWithoutNullStreams | undefined {
    const active = this.#active;
    if (active === undefined) return undefined;
    this.#active = undefined;
    const { child, listeners } = active;
    child.stdout.off("data", listeners.stdout);
    child.stderr.off("data", listeners.stderr);
    child.stdin.off("drain", listeners.stdinDrain);
    child.stdin.off("error", listeners.stdinError);
    child.off("error", listeners.error);
    child.off("close", listeners.close);

    // A retired child may still report its terminal pipe error. Node throws an
    // `error` event with no listener, but this error must not revive the old
    // generation either.
    const ignoreError = (): void => undefined;
    child.on("error", ignoreError);
    child.stdin.on("error", ignoreError);
    child.once("close", () => {
      child.off("error", ignoreError);
      child.stdin.off("error", ignoreError);
    });
    child.stdin.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return child;

    child.kill("SIGTERM");
    const escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, this.#terminationGraceMs);
    const stopEscalation = (): void => clearTimeout(escalation);
    child.once("close", stopEscalation);
    child.once("exit", stopEscalation);
    escalation.unref?.();
    return child;
  }
}
