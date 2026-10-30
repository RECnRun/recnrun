import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";

/** Hears an origin agent's link; returns true when it keeps the link, which then stays open. */
export type AgentPortListener = (port: OriginPort) => boolean;

/** The origin agents' links as the workspace's waits listen for them. */
export interface AgentPortEvent {
  addListener: (listener: AgentPortListener) => void;
  removeListener: (listener: AgentPortListener) => void;
}

/** Chrome's `runtime.onConnect`, as far as the routing needs it. */
interface ConnectEvent {
  addListener: (listener: (port: OriginPort) => void) => void;
}

/**
 * Hands each agent link to every listener in turn and ends at once one that none keeps: a page of
 * the origin that loads while a barrier's agent is registered opens a link no wait asked for, even
 * after every wait ended. Other ports are left to their own listeners.
 */
export function agentPorts() {
  const listeners = new Set<AgentPortListener>();
  const event: AgentPortEvent = {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
  };
  const dispatch = (port: OriginPort) => {
    if (port.name !== ORIGIN_AGENT_PORT) return;
    let kept = false;
    // As Chrome does, a listener added while a link is handed on hears only later links.
    for (const listener of Array.from(listeners)) kept = listener(port) || kept;
    if (!kept) port.disconnect();
  };
  return { event, dispatch, listeners };
}

const chromeRoute = agentPorts();

/** The agent links Chrome opens, once `routeAgentPorts` routes them. */
export const chromeAgentPorts: AgentPortEvent = chromeRoute.event;

/** Routes every agent link through `chromeAgentPorts`; the background calls it once as it starts. */
export function routeAgentPorts(onConnect: ConnectEvent): void {
  onConnect.addListener(chromeRoute.dispatch);
}
