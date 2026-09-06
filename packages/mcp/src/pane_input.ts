import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pane } from "libtmux";

import type { PaneInputConflict } from "./command.js";
import type { PaneInputObservation } from "./context.js";
import { fail } from "./results.js";
import {
  isFailure,
  requirePaneInputTarget,
  resolvedPaneInputTargetIds,
} from "./target_resolution.js";

export interface PaneInputPlan {
  readonly observation: PaneInputObservation;
  readonly pane: Pane;
  readonly resolvedPaneIds: readonly string[];
  readonly signature: string;
}

/** Resolve every pane one tmux input operation can reach from one authenticated instant. */
export function planPaneInput(
  observation: PaneInputObservation,
  paneId: string,
  force: boolean | undefined,
  verb: string,
): CallToolResult | PaneInputPlan {
  const { identity, snapshot } = observation;
  const pane = requirePaneInputTarget(snapshot, identity, paneId, force, verb);
  if (isFailure(pane)) return pane;
  const resolvedPaneIds = resolvedPaneInputTargetIds(pane);
  if (isFailure(resolvedPaneIds)) return resolvedPaneIds;

  const cohort: Array<Record<string, unknown>> = [];
  for (const resolvedPaneId of resolvedPaneIds) {
    const writable = requirePaneInputTarget(snapshot, identity, resolvedPaneId, force, verb);
    if (isFailure(writable)) return writable;
    cohort.push({
      command: writable.currentCommand,
      dead: writable.dead,
      inputOff: writable.inputOff,
      mode: writable.inMode,
      paneId: resolvedPaneId,
      sessionId: writable.format.session_id,
      synchronized: writable.synchronized,
      windowId: writable.window?.id ?? writable.format.window_id,
    });
  }

  return {
    observation,
    pane,
    resolvedPaneIds,
    signature: JSON.stringify({
      authority: observation.authority,
      caller: {
        attendedPaneIds: [...identity.attendedPaneIds].sort(),
        callerPaneId: identity.callerPaneId,
        callerPaneIsOnThisServer: identity.callerPaneIsOnThisServer,
        inputProblem: identity.inputProblem,
      },
      cohort,
      paneId,
    }),
  };
}

export function paneInputChanged(paneId: string, action: string): ReturnType<typeof fail> {
  return fail({
    hint: "Take a fresh snapshot and retry only after the pane is stable and unattended.",
    reason: `Pane ${paneId} changed during ${action} setup; no input was sent.`,
  });
}

export function busyPane(conflict: PaneInputConflict): ReturnType<typeof fail> {
  const run = conflict.kind === "run";
  return fail({
    hint: "Wait for the active pane input operation to finish.",
    reason: run
      ? `Refusing to write into ${conflict.paneId}: run_shell_command ${conflict.description} is still active.`
      : `Refusing to write into ${conflict.paneId}: another pane input operation is still active.`,
  });
}

/** Dispatch keys and optional Enter as one daemon-guarded tmux command list. */
export async function dispatchPaneKeys(
  pane: Pane,
  keys: string,
  options: { readonly enter?: boolean; readonly literal?: boolean } = {},
): Promise<void> {
  const enter = options.enter !== false;
  await pane.cmd(
    "send-keys",
    options.literal === true
      ? ["-l", enter ? `${keys}\n` : keys]
      : [keys, ...(enter ? ["Enter"] : [])],
  );
}
