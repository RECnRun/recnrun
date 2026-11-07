// Types of interact-view.js for the Node tests of the master's input queue.
export interface Coalesce<T> {
  (item: T): void;
  ordered: (task: () => Promise<unknown>) => Promise<void>;
}

export declare const coalescer: <T>(
  send: (item: T) => unknown,
  merge: (older: T, newer: T) => T,
  stats: { coalesced: number },
) => Coalesce<T>;
