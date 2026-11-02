// The engine compiles without DOM or Node types; every runtime it runs in has this timer.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** Time for the executor; unit tests pass a fake one whose `sleep` advances `now` at once. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Pause between two reads of the page; condition-based, never a recorded delay. */
export const POLL_INTERVAL_MS = 100;

/** A read never waits less than this, so the last poll before a deadline can still answer. */
const MIN_READ_MS = 50;

/** One step's deadline, shared by every read and the dispatch that follow. */
export interface Deadline {
  readonly at: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
}

export function deadlineIn(timeoutMs: number, clock: Clock): Deadline {
  return { at: clock.now() + timeoutMs, timeoutMs, clock };
}

export function remaining(deadline: Deadline): number {
  return deadline.at - deadline.clock.now();
}

export function readTimeout(deadline: Deadline): { timeoutMs: number } {
  return { timeoutMs: Math.max(MIN_READ_MS, remaining(deadline)) };
}

/** The last thing a poll saw: a value that did not meet the condition, or an error a read threw. */
export type Poll<T> =
  | { met: true; value: T; attempts: number }
  | { met: false; value?: T; error?: unknown; attempts: number };

/**
 * Reads until `met` holds or the deadline passes. Reading never changes the page, so repeating
 * it is safe; a read that throws (a document mid-navigation) is read again.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  met: (value: T) => boolean,
  deadline: Deadline,
): Promise<Poll<T>> {
  let last: Poll<T> = { met: false, attempts: 0 };
  for (let attempts = 1; ; attempts += 1) {
    try {
      const value = await read();
      if (met(value)) return { met: true, value, attempts };
      last = { met: false, value, attempts };
    } catch (error) {
      // Keep the last value read: it says more about the page than a transient error does.
      last = { met: false, value: last.value, error, attempts };
    }
    const left = remaining(deadline);
    if (left <= 0) return last;
    await deadline.clock.sleep(Math.min(POLL_INTERVAL_MS, left));
  }
}
