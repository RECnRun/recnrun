import type { Worker } from "@playwright/test";

interface AgentLinkPort {
  name: string;
  sender?: { tab?: { id?: number } };
  postMessage: (message: unknown) => void;
}

interface LinkGlobal {
  chrome: {
    runtime: { onConnect: { addListener(listener: (port: AgentLinkPort) => void): void } };
  };
  recnrunAgentLinks?: { tabId?: number; port: AgentLinkPort }[];
}

const AGENT_PORT = "recnrun-origin-agent";

/** Records, from now on, every origin agent link the service worker receives, with its tab. */
export const watchAgentLinks = (serviceWorker: Worker) =>
  serviceWorker.evaluate((name) => {
    const scope = globalThis as unknown as LinkGlobal;
    scope.recnrunAgentLinks = [];
    scope.chrome.runtime.onConnect.addListener((port) => {
      if (port.name === name) scope.recnrunAgentLinks?.push({ tabId: port.sender?.tab?.id, port });
    });
  }, AGENT_PORT);

/** The tabs of the recorded agent links, in the order they connected. */
export const agentLinkTabs = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() =>
    ((globalThis as unknown as LinkGlobal).recnrunAgentLinks ?? []).map(({ tabId }) => tabId),
  );

/**
 * The tabs of the recorded links, of tab `only` when given, the background still holds open:
 * Chrome refuses a message on a port its own end disconnected, and a live agent ends a link that
 * sends it anything but a probe, so a link still in use must not be asked.
 */
export const openAgentLinkTabs = (serviceWorker: Worker, only?: number) =>
  serviceWorker.evaluate((tab) => {
    const links = (globalThis as unknown as LinkGlobal).recnrunAgentLinks ?? [];
    return links.flatMap(({ tabId, port }) => {
      if (tab !== undefined && tabId !== tab) return [];
      try {
        port.postMessage({ type: "still-open" });
        return [tabId];
      } catch {
        return [];
      }
    });
  }, only);
