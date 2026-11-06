import { setTimeout as delay } from "node:timers/promises";

/** A loop of `run` every `everyMs`; the stop ends it and rethrows the first failure. */
export function loop(run: () => Promise<unknown>, everyMs: number): () => Promise<void> {
  const abort = new AbortController();
  let failure: unknown;
  const done = (async () => {
    while (!abort.signal.aborted) {
      await run().catch((error: unknown) => (failure ??= error));
      await delay(everyMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  })();
  return async () => {
    abort.abort();
    await done;
    if (failure !== undefined) throw failure;
  };
}
