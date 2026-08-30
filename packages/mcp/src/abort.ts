/** The caller's cancellation reason, normalized for code paths that need to throw. */
export function cancellation(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("request cancelled");
}

/** Throw when work must not begin or continue for this caller. */
export function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancellation(signal);
}

/** Stop awaiting shared work without cancelling the work for its other waiters. */
export function waitForAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(cancellation(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener("abort", aborted);
      reject(cancellation(signal));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
