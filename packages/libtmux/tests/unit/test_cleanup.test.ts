import { channel } from "node:diagnostics_channel";

import { describe, expect, test } from "bun:test";

import { runWithCleanup } from "../../src/_internal/test/testkit.js";

describe("runWithCleanup", () => {
  test("cleanup failure replaces success but remains secondary to a primary failure", async () => {
    const cleanup = new Error("cleanup failed");
    await expect(
      runWithCleanup(
        async () => "passed",
        async () => {
          throw cleanup;
        },
      ),
    ).rejects.toBe(cleanup);

    const primary = new Error("test failed");
    try {
      await runWithCleanup(
        async () => {
          throw primary;
        },
        async () => {
          throw cleanup;
        },
      );
      throw new Error("expected primary failure");
    } catch (error) {
      expect(error).toBe(primary);
      expect((error as Error & { cleanupError?: unknown }).cleanupError).toBe(cleanup);
    }
  });

  test("preserves frozen and primitive primary failures while reporting cleanup failure", async () => {
    const cleanup = new Error("secondary cleanup failure");
    const reports: unknown[] = [];
    const cleanupChannel = channel("libtmux.test.cleanup-failure");
    const listener = (message: unknown): void => {
      reports.push(message);
    };
    cleanupChannel.subscribe(listener);
    try {
      const frozen = Object.freeze(new Error("frozen primary"));
      await expect(
        runWithCleanup(
          async () => {
            throw frozen;
          },
          async () => {
            throw cleanup;
          },
        ),
      ).rejects.toBe(frozen);
      await expect(
        runWithCleanup(
          async () => {
            throw "primitive primary";
          },
          async () => {
            throw cleanup;
          },
        ),
      ).rejects.toBe("primitive primary");
      let caughtUndefined = false;
      try {
        await runWithCleanup(
          async () => {
            throw undefined;
          },
          async () => {
            throw cleanup;
          },
        );
      } catch (error) {
        caughtUndefined = true;
        expect(error).toBeUndefined();
      }
      expect(caughtUndefined).toBe(true);
      expect(reports).toEqual([
        { cleanupError: cleanup, primary: frozen },
        { cleanupError: cleanup, primary: "primitive primary" },
        { cleanupError: cleanup, primary: undefined },
      ]);
    } finally {
      cleanupChannel.unsubscribe(listener);
    }
  });

  test("preserves a primary with a non-configurable cleanupError property", async () => {
    const primary = new Error("primary with reserved cleanup property");
    const existingCleanup = new Error("existing cleanup evidence");
    Object.defineProperty(primary, "cleanupError", {
      configurable: false,
      enumerable: false,
      value: existingCleanup,
      writable: false,
    });
    const cleanup = new Error("secondary cleanup failure");
    const reports: unknown[] = [];
    const cleanupChannel = channel("libtmux.test.cleanup-failure");
    const listener = (message: unknown): void => {
      reports.push(message);
    };
    cleanupChannel.subscribe(listener);
    try {
      await expect(
        runWithCleanup(
          async () => {
            throw primary;
          },
          async () => {
            throw cleanup;
          },
        ),
      ).rejects.toBe(primary);
      expect((primary as Error & { cleanupError: unknown }).cleanupError).toBe(existingCleanup);
      expect(reports).toEqual([{ cleanupError: cleanup, primary }]);
    } finally {
      cleanupChannel.unsubscribe(listener);
    }
  });

  test("preserves a hostile proxy primary when cleanup reporting reflects on it", async () => {
    const target = new Error("hostile proxy primary");
    const primary = new Proxy(target, {
      getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
        throw new Error("primary reflection failed");
      },
      isExtensible(): boolean {
        throw new Error("primary extensibility failed");
      },
    });
    const cleanup = new Error("secondary cleanup failure");

    await expect(
      runWithCleanup(
        async () => {
          throw primary;
        },
        async () => {
          throw cleanup;
        },
      ),
    ).rejects.toBe(primary);
  });
});
