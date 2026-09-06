import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pane } from "libtmux";

import type { PaneInputConflict } from "./command.js";
import type { PaneInputObservation } from "./context.js";
import { fail } from "./results.js";
import {
  isFailure,
  panePlacements,
  requirePaneInputTarget,
  resolvedPaneInputTargetIds,
} from "./target_resolution.js";

export interface PaneInputPlan {
  readonly observation: PaneInputObservation;
  readonly pane: Pane;
  readonly resolvedPaneIds: readonly string[];
  readonly signature: string;
}

interface PanePlacementSignature {
  readonly sessionId: string;
  readonly windowActive: boolean | null;
  readonly windowId: string;
  readonly windowIndex: number;
}

interface PanePlacementPlan {
  readonly placements: readonly PanePlacementSignature[];
  readonly state: Readonly<Record<string, unknown>>;
}

function canonicalIndex(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function stablePanePlacements(
  observation: PaneInputObservation,
  paneId: string,
): CallToolResult | PanePlacementPlan {
  const placements = panePlacements(observation.snapshot, paneId) as readonly Pane[];
  const first = placements[0];
  if (first === undefined) {
    return fail({ reason: `Pane ${paneId} disappeared from its linked placements.` });
  }
  const state = {
    command: first.currentCommand,
    dead: first.dead,
    inputOff: first.inputOff,
    mode: first.inMode,
    synchronized: first.synchronized,
  };
  const encodedState = JSON.stringify(state);
  const topology: PanePlacementSignature[] = [];
  const seen = new Set<string>();
  for (const placement of placements) {
    if (
      placement.id !== paneId ||
      JSON.stringify({
        command: placement.currentCommand,
        dead: placement.dead,
        inputOff: placement.inputOff,
        mode: placement.inMode,
        synchronized: placement.synchronized,
      }) !== encodedState
    ) {
      return fail({
        hint: "Refresh the pane snapshot before sending input.",
        reason: `Pane ${paneId} has inconsistent state across linked placements.`,
      });
    }

    const sessionId = placement.format.session_id;
    const formatWindowId = placement.format.window_id;
    const window = placement.window;
    const windowId = window?.id;
    const formatIndex = canonicalIndex(placement.format.window_index);
    const relationIndex = canonicalIndex(window?.index);
    const windowIndex = relationIndex ?? formatIndex;
    const active = window?.active;
    if (
      !/^\$(?:0|[1-9][0-9]*)$/u.test(sessionId) ||
      !/^@(?:0|[1-9][0-9]*)$/u.test(formatWindowId ?? "") ||
      !/^@(?:0|[1-9][0-9]*)$/u.test(windowId ?? "") ||
      formatIndex === undefined ||
      windowIndex === undefined ||
      formatWindowId !== windowId ||
      (window?.index !== null && window?.index !== undefined && relationIndex === undefined) ||
      (relationIndex !== undefined && relationIndex !== formatIndex) ||
      (active !== null && active !== undefined && typeof active !== "boolean")
    ) {
      return fail({
        hint: "Refresh the pane snapshot before sending input.",
        reason: `Pane ${paneId} has malformed linked-window placement state.`,
      });
    }
    const signature = {
      sessionId,
      windowActive: typeof active === "boolean" ? active : null,
      windowId: windowId ?? "",
      windowIndex,
    };
    const key = JSON.stringify([sessionId, signature.windowId, windowIndex]);
    if (seen.has(key)) {
      return fail({
        hint: "Refresh the pane snapshot before sending input.",
        reason: `Pane ${paneId} has duplicate linked-window placement state.`,
      });
    }
    seen.add(key);
    topology.push(signature);
  }
  topology.sort(
    (left, right) =>
      left.sessionId.localeCompare(right.sessionId, "en", { numeric: true }) ||
      left.windowIndex - right.windowIndex,
  );
  return { placements: topology, state };
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
  let linkedTopology: string | undefined;
  for (const resolvedPaneId of resolvedPaneIds) {
    const writable = requirePaneInputTarget(snapshot, identity, resolvedPaneId, force, verb);
    if (isFailure(writable)) return writable;
    const stable = stablePanePlacements(observation, resolvedPaneId);
    if (isFailure(stable)) return stable;
    const topology = JSON.stringify(stable.placements);
    if (linkedTopology !== undefined && topology !== linkedTopology) {
      return fail({
        hint: "Refresh the pane snapshot before sending input.",
        reason: "The configured input cohort has inconsistent linked-window topology.",
      });
    }
    linkedTopology = topology;
    cohort.push({
      paneId: resolvedPaneId,
      placements: stable.placements,
      ...stable.state,
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
