import type { NavigationApi } from "@/background/workspace/navigation";
import { fakeAgentPorts, fakeEvent } from "./fake-port";

/** Tab navigation and runtime ports as the background sees them; tests emit Chrome's events. */
export function fakeNavigationApi() {
  const api = {
    updates: [] as { tabId: number; url: string }[],
    reloads: [] as { tabId: number; documentId: string }[],
    failUpdate: undefined as Error | undefined,
    onCommitted:
      fakeEvent<[{ tabId: number; frameId: number; url: string; documentId?: string }]>(),
    onErrorOccurred: fakeEvent<[{ tabId: number; frameId: number; error: string }]>(),
    onTabRemoved: fakeEvent<[number]>(),
    onConnect: fakeAgentPorts(),
    update: async (tabId: number, url: string) => {
      if (api.failUpdate) throw api.failUpdate;
      api.updates.push({ tabId, url });
    },
    reload: async (tabId: number, documentId: string) => {
      api.reloads.push({ tabId, documentId });
    },
  };
  return api satisfies NavigationApi;
}

export type FakeNavigationApi = ReturnType<typeof fakeNavigationApi>;

/** Every listener the code under test still holds, to prove it detached them all. */
export const listenerCount = (api: FakeNavigationApi) =>
  api.onCommitted.listeners.size +
  api.onErrorOccurred.listeners.size +
  api.onTabRemoved.listeners.size +
  api.onConnect.listeners.size;
