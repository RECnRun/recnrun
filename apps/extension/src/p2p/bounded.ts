/** Rejects with a message naming `what` when `work` settles later than `ms`; the timer never outlives it. */
export function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not finish within ${ms / 1000} s.`)),
      ms,
    );
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
