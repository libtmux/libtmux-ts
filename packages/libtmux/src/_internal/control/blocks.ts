import type { TmuxEvent } from "../../types.js";
import type { ControlBlockBoundary, GuardIdentity } from "./events.js";

/**
 * Where one line falls relative to the command response tmux is writing.
 *
 * `notification` carries the event so the caller does not have to re-narrow
 * what this already decided. `ignore` is a line with nowhere to go: a guard
 * closing a block that was never opened.
 */
export type BlockPosition =
  | { readonly fromClient: boolean; readonly kind: "begin" }
  | { readonly kind: "body" }
  | { readonly failed: boolean; readonly fromClient: boolean; readonly kind: "end" }
  | { readonly event: TmuxEvent; readonly kind: "notification" }
  | { readonly kind: "ignore" };

function sameGuard(left: GuardIdentity, right: GuardIdentity): boolean {
  return left.number === right.number && left.time === right.time;
}

/**
 * Which of tmux's guards open and close the block this client is reading.
 *
 * A command's output reaches a control client unescaped, so a pane printing
 * `%end 1 2 1` is a guard by every test of shape. Only the time and command
 * number tmux stamped on the opening `%begin` say which lines are really
 * boundaries, so this pairs on them and treats everything else between as body.
 * Unpaired, a printed `%end` truncates a capture, a printed `%error` fails a
 * command that succeeded, and a printed `%begin` takes the next caller's place
 * in the queue and leaves every command after it answering with its
 * predecessor's reply.
 *
 * Ownership is read from the opening guard rather than the closing one. Both
 * carry the same flag, and the block was bound to a pending command when it
 * opened, so that is the answer that has to stay true.
 */
export class BlockTracker {
  #open: { readonly fromClient: boolean; readonly guard: GuardIdentity } | undefined;

  /** Whether a command's response is being read. */
  get inBlock(): boolean {
    return this.#open !== undefined;
  }

  /**
   * Place one parsed line, advancing the block state.
   *
   * Call once per line and in arrival order: a `begin` and its paired `end`
   * each change what the lines between them mean.
   */
  position(parsed: ControlBlockBoundary | TmuxEvent | undefined): BlockPosition {
    const open = this.#open;
    if (open !== undefined) {
      if (parsed?.kind === "block-end" && sameGuard(parsed.guard, open.guard)) {
        this.#open = undefined;
        return { failed: parsed.failed, fromClient: open.fromClient, kind: "end" };
      }
      return { kind: "body" };
    }
    if (parsed === undefined) return { kind: "ignore" };
    if (parsed.kind === "block-begin") {
      this.#open = { fromClient: parsed.fromClient, guard: parsed.guard };
      return { fromClient: parsed.fromClient, kind: "begin" };
    }
    // Reachable only from a tmux that closed a block it never opened. Answering
    // an unopened block would resolve an attach nobody asked about.
    if (parsed.kind === "block-end") return { kind: "ignore" };
    return { event: parsed, kind: "notification" };
  }

  /** Forget the open block. A reconnect is a different process mid-sentence. */
  reset(): void {
    this.#open = undefined;
  }
}
