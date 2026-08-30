import type {
  CommandOptions,
  JoinOptions,
  Pane,
  Selection,
  ServerSnapshot,
  SetOptionOptions,
  TmuxEvent,
  TmuxEventStream,
  TmuxOutputEvent,
  Window,
} from "libtmux";
import { Session } from "libtmux";

/**
 * A consumer with no ambient types at all.
 *
 * This compiles against the emitted declarations with `types: []` and only the
 * ECMAScript lib — no `@types/node`, no DOM. A package whose public types reach
 * for `Buffer`, `NodeJS.*`, `AbortSignal`, or `process` forces every consumer to
 * install those too, which is why `AbortLike` is structural rather than a DOM
 * `AbortSignal`. Nothing else checks that, so it would regress silently.
 *
 * The negative cases are the other half: a query API that accepts a misspelt
 * field is not type-safe, it is just typed.
 */

declare const snapshot: ServerSnapshot;
declare const event: TmuxEvent;
declare const pane: Pane;
declare const session: Session;
declare const commandOptions: CommandOptions;
declare const joinOptions: JoinOptions;
declare const mixed: Selection<Session | Window>;
declare const setOptionOptions: SetOptionOptions;
declare const stream: TmuxEventStream;

// @ts-expect-error a criteria key that does not exist
snapshot.panes.where({ currentCommnd: "vim" });

// @ts-expect-error a scalar field given a shape it does not accept
snapshot.panes.where({ active: { nope: 1 } });

// @ts-expect-error a relation quantifier misspelt
snapshot.windows.where({ session: { iz: { name: "x" } } });

// @ts-expect-error a field belonging to a different event member
if (event.kind === "exit") void event.paneId;

// @ts-expect-error a Selection is immutable and ordered, not an Array
snapshot.panes.push(pane);

// @ts-expect-error a handle's scalars come from the snapshot that read them
pane.id = "%9";

// Narrowing on the discriminant reaches the member's fields without a cast.
if (event.kind === "output") {
  const data: string = event.data;
  const paneId: string = event.paneId;
  void data;
  void paneId;
}

async function findOutput(): Promise<void> {
  const output = await stream.find(
    (candidate): candidate is TmuxOutputEvent => candidate.kind === "output",
  );
  if (output !== undefined) {
    void output.data;
    // @ts-expect-error output events have no window id.
    void output.windowId;
  }
}

// The ordinary surface resolves with no ambient types in scope.
void session.activePane;
void commandOptions.stdin;
void joinOptions.vertical;
void setOptionOptions.append;
void findOutput;
void pane.toString();
void snapshot.panes.where({ currentCommand: "vim" }).one();
void snapshot.sessions.filter((candidate) => candidate.name !== null);
const narrowedSessions: Selection<Session> = mixed.filter(
  (candidate): candidate is Session => candidate instanceof Session,
);
void narrowedSessions;
