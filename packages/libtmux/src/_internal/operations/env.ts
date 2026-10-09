import { LibTmuxError } from "../../errors.js";
import { tmuxContextSocket } from "../runtime/endpoint.js";

export interface TmuxEnvironment {
  readonly socketPath: string;
  readonly paneId: string;
}

/**
 * Read the tmux server and pane a process is running inside.
 *
 * `$TMUX` is `socket-path,pid,session-id`, and a socket path may itself contain
 * commas, so the split is anchored from the right. The exported session id is
 * deliberately ignored: it goes stale when a pane moves between sessions, while
 * `$TMUX_PANE` stays correct, so the session is resolved through the pane.
 */
export function readTmuxEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): TmuxEnvironment {
  const tmux = environment.TMUX;
  if (tmux === undefined || tmux === "") {
    throw new LibTmuxError("$TMUX is not set; this process is not inside tmux");
  }
  let socketPath: string;
  try {
    socketPath = tmuxContextSocket(tmux);
  } catch (cause) {
    throw new LibTmuxError(`$TMUX is malformed: ${tmux}`, { cause });
  }

  const paneId = environment.TMUX_PANE;
  if (paneId === undefined || !/^%\d+$/.test(paneId)) {
    throw new LibTmuxError(`$TMUX_PANE is missing or malformed: ${paneId ?? "<unset>"}`);
  }
  return { paneId, socketPath };
}
