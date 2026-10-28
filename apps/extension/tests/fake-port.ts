import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort, OriginSender } from "@/messaging/origin-protocol";

type Listener<A extends unknown[]> = (...args: A) => void;

export function fakeEvent<A extends unknown[]>() {
  const listeners = new Set<Listener<A>>();
  return {
    listeners,
    addListener: (listener: Listener<A>) => listeners.add(listener),
    removeListener: (listener: Listener<A>) => listeners.delete(listener),
    // As Chrome does, a listener added while an event dispatches gets only later events.
    emit: (...args: A) => {
      for (const listener of Array.from(listeners)) listener(...args);
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

/**
 * Makes `port` answer the background's link probe as an agent would, echoing what `carry` makes of
 * it (structured clone keeps it as it is); probes go to `probes`, not `posted`.
 */
export function echoProbes<P extends ReturnType<typeof fakePort>>(
  port: P,
  carry: (probe: unknown) => unknown = (probe) => probe,
) {
  const post = port.postMessage;
  const probes: unknown[] = [];
  port.postMessage = (message: unknown) => {
    const { type, operationId, generation, probe } = message as Record<string, unknown>;
    if (type !== "probe") return post(message);
    probes.push(message);
    const echo = { type: "probe-echo", operationId, generation, probe: carry(probe) };
    queueMicrotask(() => port.onMessage.emit(echo));
  };
  return Object.assign(port, { probes });
}
