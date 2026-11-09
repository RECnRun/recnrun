// W7 fixes: the one input queue, bounded in depth, age, and rate; and a deadline for any await.
const GATE = { depth: 64, ageMs: 1_000, rate: 200 };
const WINDOW_MS = 1_000;

/**
 * `serial(work, skipped)` runs `work` in arrival order, or answers `skipped(code)` in its place:
 * QUEUE_FULL and RATE_LIMITED at arrival (and `onOverload` hears them), QUEUE_STALE at its turn.
 * `chain(work)` is the worker's own work on the same queue, never refused.
 */
export const createGate = ({ now = Date.now, onOverload = () => undefined, ...given } = {}) => {
  const limits = { ...GATE, ...given };
  let queue = Promise.resolve();
  let pending = 0;
  const arrivals = [];

  const overload = () => {
    const at = now();
    while (arrivals.length > 0 && at - arrivals[0] >= WINDOW_MS) arrivals.shift();
    if (arrivals.length >= limits.rate) return "RATE_LIMITED";
    arrivals.push(at);
    return pending >= limits.depth ? "QUEUE_FULL" : null;
  };

  const enqueue = (turn) => {
    pending += 1;
    const result = queue.then(turn).finally(() => {
      pending -= 1;
    });
    queue = result.catch(() => undefined);
    return result;
  };

  const serial = (work, skipped) => {
    const receivedAt = now();
    const refused = overload();
    if (refused) onOverload(refused);
    return enqueue(() => {
      if (refused) return skipped(refused);
      return now() - receivedAt > limits.ageMs ? skipped("QUEUE_STALE") : work();
    });
  };

  return { serial, chain: (work) => enqueue(work), size: () => pending };
};

/** `work`, or a rejection with `code` once `ms` pass first. */
export const within = (work, ms, code) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};
