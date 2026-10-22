import type { Transport } from "../src/index.ts";

/** Delivers every message to every subscriber, like one window shared by page and extension. */
export function memoryTransport(): Transport & { sent: unknown[] } {
  const listeners = new Set<(message: unknown) => void>();
  const sent: unknown[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      // Snapshot first: listeners subscribe and unsubscribe while handling a message.
      for (const listener of Array.from(listeners)) listener(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
