import { channel } from "node:diagnostics_channel";

/** Run cleanup after both successful and failed work without masking the primary failure. */
export async function runWithCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let primary: unknown;
  let hasPrimary = false;
  try {
    result = await body();
  } catch (error) {
    hasPrimary = true;
    primary = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!hasPrimary) throw cleanupError;
    reportSecondaryCleanupFailure(primary, cleanupError);
  }
  if (hasPrimary) throw primary;
  return result as T;
}

/** Attach cleanup evidence to a primary failure or publish it out of band. */
export function reportSecondaryCleanupFailure(primary: unknown, cleanupError: unknown): void {
  if (typeof primary === "object" && primary !== null) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(primary, "cleanupError");
      if (
        descriptor?.configurable === true ||
        (descriptor === undefined && Object.isExtensible(primary))
      ) {
        Object.defineProperty(primary, "cleanupError", {
          configurable: true,
          enumerable: false,
          value: cleanupError,
        });
        return;
      }
    } catch {
      // Cleanup reporting falls through to the diagnostics channel.
    }
  }
  channel("libtmux.test.cleanup-failure").publish({ cleanupError, primary });
}
