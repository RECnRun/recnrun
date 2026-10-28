import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort, OriginSender } from "@/messaging/origin-protocol";

type Listener<A extends unknown[]> = (...args: A) => void;

function fakeEvent<A extends unknown[]>() {
  const listeners = new Set<Listener<A>>();
  return {
    listeners,
    addListener: (listener: Listener<A>) => listeners.add(listener),
    removeListener: (listener: Listener<A>) => listeners.delete(listener),
    emit: (...args: A) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

/** A runtime port between the origin agent and the background; `posted` holds what this end sent. */
export function fakePort(sender?: OriginSender) {
  const port = {
    name: ORIGIN_AGENT_PORT,
    sender,
    posted: [] as unknown[],
    disconnected: false,
    onMessage: fakeEvent<[unknown]>(),
    onDisconnect: fakeEvent<[]>(),
    postMessage: (message: unknown) => {
      port.posted.push(message);
    },
    // As in Chrome, disconnecting one end does not fire that end's own onDisconnect.
    disconnect: () => {
      port.disconnected = true;
    },
  };
  return port satisfies OriginPort;
}
