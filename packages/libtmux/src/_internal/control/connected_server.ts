import type { ConnectedServer, ServerSnapshot, WaitForOptions } from "../../types.js";
import { createServerWithRuntime, type RuntimeContext } from "../runtime/context.js";
import type { RuntimeConstructors } from "../runtime/constructors.js";
import type { ControlConnection } from "./connection.js";
import { waitForSnapshot } from "./wait_for.js";

export function createConnectedServer(
  runtime: RuntimeContext,
  constructors: RuntimeConstructors,
  connection: ControlConnection,
): ConnectedServer {
  const server = createServerWithRuntime(runtime, constructors) as ConnectedServer;

  /**
   * The waits this connection has outstanding, so closing it can answer them.
   *
   * Closing on purpose — a caller cancelling, a scope ending — rejects every
   * wait in flight, and a wait nobody is holding any more becomes an
   * unhandled rejection the caller cannot even catch. Marking each one
   * handled first silences exactly those, and only those: a daemon that dies
   * never comes through here, so a real failure stays as loud as it was, and
   * so does a wait somebody forgot to await that later times out.
   *
   * Held as records rather than as the promises themselves. Attaching
   * `.finally` to a promise to clean up after it marks that promise handled
   * at the moment it is created, which would silence every wait always and
   * leave this looking like it worked.
   */
  const waiting = new Set<{ promise?: Promise<ServerSnapshot> }>();
  const closeWaits = (): Promise<void> => {
    for (const entry of waiting) entry.promise?.catch(() => undefined);
    return connection.close();
  };

  Object.defineProperties(server, {
    close: { value: closeWaits },
    subscribe: { value: () => connection.subscribe() },
    waitFor: {
      value: (
        matches: (snapshot: ServerSnapshot) => boolean,
        options: WaitForOptions = {},
      ): Promise<ServerSnapshot> => {
        const entry: { promise?: Promise<ServerSnapshot> } = {};
        const run = async (): Promise<ServerSnapshot> => {
          try {
            return await waitForSnapshot({
              matches,
              options,
              snapshot: () => server.snapshot(),
              subscribe: () => connection.subscribe(),
            });
          } finally {
            // Inside the body on purpose: cleaning up from outside attaches
            // a handler, which marks the promise handled the moment it exists
            // and silences every wait rather than the closed ones.
            waiting.delete(entry);
          }
        };
        const promise = run();
        entry.promise = promise;
        waiting.add(entry);
        return promise;
      },
    },
    [Symbol.asyncDispose]: { value: closeWaits },
  });
  return server;
}
