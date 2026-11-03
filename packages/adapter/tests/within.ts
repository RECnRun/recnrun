/** Fails instead of hanging when `work` never settles. */
export const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Did not resolve within ${ms} ms.`)), ms),
    ),
  ]);
