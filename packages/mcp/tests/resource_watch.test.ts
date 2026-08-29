import { expect, test } from "bun:test";

import type { TmuxEvent } from "libtmux";

import type { ToolContext } from "../src/context.js";
import type { LiveListener } from "../src/live.js";
import { resolvePolicy } from "../src/policy.js";
import { watchTopology } from "../src/resource_watch.js";

function contextWith(
  anchor: (listener: (event: TmuxEvent) => void) => Promise<LiveListener | undefined>,
): ToolContext {
  return {
    hub: { anchor, closed: false },
    policy: resolvePolicy({}),
  } as unknown as ToolContext;
}

function liveListener(): LiveListener {
  const listener = (() => undefined) as LiveListener;
  Object.defineProperty(listener, "ended", { value: new Promise(() => undefined) });
  return listener;
}

test("waits for the first topology-listener attempt before listing", async () => {
  const anchoring = Promise.withResolvers<LiveListener | undefined>();
  const watching = watchTopology(contextWith(() => anchoring.promise), () => undefined);
  let ready = false;

  const started = Promise.resolve(watching()).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);

  anchoring.resolve(liveListener());
  await started;
  expect(ready).toBe(true);
});

test("retries a missing topology listener and announces its recovery once", async () => {
  let attempts = 0;
  let events: ((event: TmuxEvent) => void) | undefined;
  let notices = 0;
  const watching = watchTopology(
    contextWith(async (listener) => {
      attempts += 1;
      if (attempts < 3) return undefined;
      events = listener;
      return liveListener();
    }),
    () => {
      notices += 1;
    },
  );

  await watching();
  expect(attempts).toBe(1);
  expect(notices).toBe(0);

  await new Promise((resolve) => setTimeout(resolve, 850));
  expect(attempts).toBe(3);
  expect(notices).toBe(1);

  events?.({ kind: "layout-change" } as TmuxEvent);
  expect(notices).toBe(2);
});
