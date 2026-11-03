import type { ServiceMessage } from "@recnrun/protocol";

/** What a subscriber follows; with neither id it receives every message. */
export interface Subscription {
  sessionId?: string | undefined;
  runId?: string | undefined;
}

/** Fans service messages out to the `/ws` channels that subscribed to their session or run. */
export interface EventHub {
  publish(message: ServiceMessage): void;
  /** Returns the function that ends the subscription. */
  subscribe(filter: Subscription, push: (message: ServiceMessage) => void): () => void;
  readonly size: number;
}

function matches(filter: Subscription, message: ServiceMessage): boolean {
  if (filter.sessionId === undefined && filter.runId === undefined) return true;
  if ("sessionId" in message && message.sessionId === filter.sessionId) return true;
  return "runId" in message && message.runId === filter.runId;
}

export function createEventHub(): EventHub {
  const subscribers = new Set<{ filter: Subscription; push: (m: ServiceMessage) => void }>();
  return {
    publish(message) {
      for (const { filter, push } of subscribers) if (matches(filter, message)) push(message);
    },
    subscribe(filter, push) {
      const entry = { filter, push };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    get size() {
      return subscribers.size;
    },
  };
}
