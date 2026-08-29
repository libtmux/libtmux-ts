export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Validate a deadline or interval before JavaScript silently coerces it. */
export function timerDuration(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be a positive timer-safe integer`);
  }
  return value;
}

/** Validate a delay for which immediate execution is meaningful. */
export function timerDelay(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be a non-negative timer-safe integer`);
  }
  return value;
}
