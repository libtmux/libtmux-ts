import type { ServerSnapshot, SessionId } from "libtmux";

/** Choose an irredundant set of sessions that observes every distinct window. */
export function coveringSessions(
  snapshot: ServerSnapshot,
  active: ReadonlyMap<SessionId, unknown>,
): Set<SessionId> {
  const bySession = new Map<SessionId, Set<string>>();
  const uncovered = new Set<string>();
  for (const window of snapshot.windows.toArray()) {
    uncovered.add(window.id);
    const sessionId = window.format.session_id;
    const windows = bySession.get(sessionId) ?? new Set<string>();
    windows.add(window.id);
    bySession.set(sessionId, windows);
  }

  const desired = new Set<SessionId>();
  while (uncovered.size > 0) {
    let best: SessionId | undefined;
    let bestActive = false;
    let bestScore = 0;
    for (const [sessionId, windows] of bySession) {
      if (desired.has(sessionId)) continue;
      let score = 0;
      for (const windowId of windows) {
        if (uncovered.has(windowId)) score += 1;
      }
      const isActive = active.has(sessionId);
      if (score > bestScore || (score === bestScore && isActive && !bestActive)) {
        best = sessionId;
        bestActive = isActive;
        bestScore = score;
      }
    }
    if (best === undefined || bestScore === 0) break;
    desired.add(best);
    for (const windowId of bySession.get(best) ?? []) uncovered.delete(windowId);
  }

  for (const candidate of desired) {
    const windows = bySession.get(candidate) ?? [];
    let needed = false;
    for (const windowId of windows) {
      let coveredElsewhere = false;
      for (const other of desired) {
        if (other !== candidate && bySession.get(other)?.has(windowId) === true) {
          coveredElsewhere = true;
          break;
        }
      }
      if (coveredElsewhere) continue;
      needed = true;
      break;
    }
    if (!needed) desired.delete(candidate);
  }
  return desired;
}
