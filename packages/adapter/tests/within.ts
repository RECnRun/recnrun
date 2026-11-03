/** Fails instead of hanging when `work` never settles. */
export const within = (work: Promise<void>, ms: number) =>
  Promise.race([
    work,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Did not resolve within ${ms} ms.`)), ms),
    ),
  ]);
