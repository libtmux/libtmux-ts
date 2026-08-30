import { Server, type SafeInteger } from "libtmux";

export interface PaneReport {
  readonly area: number;
  readonly activeCount: number;
  readonly pids: readonly SafeInteger[];
  readonly sessionAgeMs: number;
}

/**
 * Read a server without parsing anything out of a string.
 *
 * Every step here appears in README.md.
 */
export async function reportPanes(server: Server): Promise<PaneReport> {
  const session = await server.newSession({ name: "fields" });
  await session.newWindow({ name: "second" });

  const snapshot = await server.snapshot();
  const panes = snapshot.panes.where({ session: { is: { name: "fields" } } });

  // Numbers arrive as numbers, so geometry is arithmetic rather than parsing.
  const area = panes
    .toArray()
    .reduce((total, pane) => total + (pane.width ?? 0) * (pane.height ?? 0), 0);

  // Flags arrive as booleans. `"0"` is truthy; `false` is not.
  const activeCount = panes.count({ active: true });

  // A criterion takes the decoded shape as readily as the text tmux sends.
  const pids = panes
    .toArray()
    .map((pane) => pane.panePid)
    .filter((pid) => pid !== null);

  // Times arrive as Date.
  const created = snapshot.sessions.one({ name: "fields" }).created;
  if (created === null) throw new Error("expected tmux to report a creation time");
  const sessionAgeMs = Date.now() - created.getTime();

  // The text tmux actually sent is still on the row. Each window has an active
  // pane, so this narrows to one window before asking for one pane.
  const raw = panes.one({ active: true, window: { is: { name: "second" } } }).format.pane_active;
  if (raw !== "1") throw new Error(`expected the raw row to hold "1", saw ${JSON.stringify(raw)}`);

  return { activeCount, area, pids, sessionAgeMs };
}
