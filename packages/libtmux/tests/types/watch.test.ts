import type { Server, TmuxEvent, TmuxEventStream, TmuxOutputEvent } from "../../src/index.js";
import type { Equal, Expect } from "./assert.js";

/**
 * The disposal and narrowing guarantees `watch()` advertises, checked by tsc.
 *
 * The integration suite calls `Symbol.asyncDispose` directly because the lint
 * rule for `await using` does not resolve the protocol through an interface.
 * These declarations are where the syntax a consumer actually writes is pinned.
 */
declare const server: Server;

export async function disposesOnScopeExit(): Promise<void> {
  await using events = server.watch();
  for await (const event of events) void event;
}

export async function disposesWithOptions(): Promise<void> {
  await using events = server.watch({ bufferSize: 8, target: "work" });
  void events.dropped;
  await events.close();
}

export async function narrowsOnKind(): Promise<string> {
  for await (const event of server.watch()) {
    switch (event.kind) {
      case "output":
        return `${event.paneId}${event.data}${String(event.age ?? "")}`;
      case "window-add":
      case "window-close":
      case "unlinked-window-add":
      case "unlinked-window-close":
        return event.windowId;
      case "window-renamed":
      case "unlinked-window-renamed":
        return `${event.windowId}${event.name}`;
      case "window-pane-changed":
        return `${event.windowId}${event.paneId}`;
      case "layout-change":
        return `${event.layout}${event.visibleLayout}${event.flags}`;
      case "session-changed":
      case "session-renamed":
        return `${event.sessionId}${event.name}`;
      case "sessions-changed":
        return "";
      case "session-window-changed":
        return `${event.sessionId}${event.windowId}`;
      case "client-session-changed":
        return `${event.client}${event.sessionId}${event.name}`;
      case "client-detached":
        return event.client;
      case "pane-mode-changed":
      case "continue":
      case "pause":
        return event.paneId;
      case "paste-buffer-changed":
      case "paste-buffer-deleted":
        return event.buffer;
      case "config-error":
      case "message":
        return event.message;
      case "exit":
        return event.reason ?? "";
      case "reconnected":
        return String(event.attempts);
      case "unknown":
        return `${event.name}${event.args.join("")}`;
    }
  }
  return "";
}

/** Every member of the union is handled above, so the switch is exhaustive. */
export function exhaustive(event: TmuxEvent): never | void {
  if (event.kind === "output") return;
}

declare const stream: TmuxEventStream;
export const isIterable: AsyncIterable<TmuxEvent> = stream;

export async function findNarrowsWithTypePredicate(): Promise<void> {
  const event = await stream.find(
    (candidate): candidate is TmuxOutputEvent => candidate.kind === "output",
  );
  type _FindNarrows = Expect<Equal<typeof event, TmuxOutputEvent | undefined>>;

  if (event !== undefined) {
    void event.data;
    // @ts-expect-error output events have no window id.
    void event.windowId;
  }
}

export async function findWithTruthyPredicate(): Promise<void> {
  const matchesOutput = (candidate: TmuxEvent): string =>
    candidate.kind === "output" ? "yes" : "";
  const event = await stream.find(matchesOutput);
  type _FindRemainsBroad = Expect<Equal<typeof event, TmuxEvent | undefined>>;
  void event;
}

/**
 * `signal` is typed structurally so the declarations need no DOM library; a
 * real AbortSignal has to keep satisfying it.
 */
export function acceptsRealAbortSignal(controller: AbortController): TmuxEventStream {
  return server.watch({ signal: controller.signal });
}

export function connectIsNotAnObserver(): Promise<unknown> {
  // @ts-expect-error pause-after belongs to Server.watch(), not Server.connect().
  return server.connect({ pauseAfterSeconds: 1 });
}

export function watchIsNotACommandChannel(): TmuxEventStream {
  // @ts-expect-error command response bounds belong to Server.connect().
  return server.watch({ maxCommandBytes: 1 });
}
