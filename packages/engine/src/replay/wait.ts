import { StepFailure } from "./outcome.ts";

// The engine compiles without DOM or Node types; every runtime it runs in has these timers.
declare const setTimeout: (callback: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

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

/** One step's deadline, shared by every read and the dispatch that follow. */
export interface Deadline {
  readonly at: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  /** True once the run was cut short; the step's time is then up. */
  readonly stopped?: (() => boolean) | undefined;
}

export function deadlineIn(timeoutMs: number, clock: Clock, stopped?: () => boolean): Deadline {
  return { at: clock.now() + timeoutMs, timeoutMs, clock, stopped };
}

export function remaining(deadline: Deadline): number {
  if (deadline.stopped?.()) return 0;
  return deadline.at - deadline.clock.now();
}

/** The budget a driver call gets: what is left of the step, at least 1 ms. */
export function readTimeout(deadline: Deadline): { timeoutMs: number } {
  return { timeoutMs: Math.max(1, remaining(deadline)) };
}

const lateAnswer = (deadline: Deadline, what: string): StepFailure =>
  new StepFailure("timeout", `${what} did not answer within ${deadline.timeoutMs} ms.`);

/**
 * Settles with the call, or rejects with a `timeout` StepFailure once the deadline passes; an
 * answer after it counts as none. Real time bounds a stalled call even under a fake clock.
 */
export async function beforeDeadline<T>(
  call: Promise<T>,
  deadline: Deadline,
  what: string,
): Promise<T> {
  let handle: unknown;
  const expired = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(lateAnswer(deadline, what)), Math.max(0, remaining(deadline)));
  });
  try {
    const value = await Promise.race([call, expired]);
    if (remaining(deadline) < 0) throw lateAnswer(deadline, what);
    return value;
  } finally {
    clearTimeout(handle);
  }
}

/** The last thing a poll saw: a value that did not meet the condition, or an error a read threw. */
export type Poll<T> =
  | { met: true; value: T; attempts: number }
  | { met: false; value?: T; error?: unknown; attempts: number };

/**
 * Reads until `met` holds or the deadline passes. Reading never changes the page, so repeating
 * it is safe; a read that throws (a document mid-navigation) is read again, and a read that
 * answers after the deadline is not believed.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  met: (value: T) => boolean,
  deadline: Deadline,
): Promise<Poll<T>> {
  let last: Poll<T> = { met: false, attempts: 0 };
  for (let attempts = 1; ; attempts += 1) {
    try {
      const value = await beforeDeadline(read(), deadline, "The page read");
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
