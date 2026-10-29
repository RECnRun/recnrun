import { vi } from "vite-plus/test";
import type { HelperTabApi } from "@/background/workspace/helper-tab";
import type { ResponseUrls, ResponseUrlStore } from "@/ports/response-urls";
import type { LayoutPlace, TabVisits, Visit, VisitedOrigins } from "@/ports/visited-origins";
import { fakeBarrierApi } from "./fake-barrier";
import { fakeNavigationApi } from "./fake-navigation";
import type { FakeNavigationApi } from "./fake-navigation";
import { echoProbes, fakePort } from "./fake-port";

/** Helper tabs as Chrome opens and closes them, numbered from `firstId`. */
export function fakeHelperTabs(firstId = 100) {
  const tabs = {
    opened: [] as { tabId: number; windowId: number }[],
    closed: [] as number[],
    open: vi.fn(async (windowId: number) => {
      const tabId = firstId + tabs.opened.length;
      tabs.opened.push({ tabId, windowId });
      return tabId;
    }),
    close: vi.fn(async (tabId: number) => {
      tabs.closed.push(tabId);
    }),
  };
  return tabs satisfies HelperTabApi;
}

/** `list` with `added` merged in by origin, as the stored list merges them. */
function mergedInto(list: readonly Visit[], added: readonly Visit[]): Visit[] {
  const merging = [...list];
  for (const visit of added) {
    const index = merging.findIndex(({ origin }) => origin === visit.origin);
    merging.splice(index === -1 ? merging.length : index, index === -1 ? 0 : 1, visit);
  }
  return merging;
}

/** The session list of visited origins, in memory: one generation's lists at a time. */
export function memoryVisits(generation = 0, initial: Visit[] = [], tabs: TabVisits[] = []) {
  const visits = {
    list: { generation, visits: [...initial] },
    tabs: { generation, tabs: [...tabs] },
    note: vi.fn(async (noted: number, added: readonly Visit[]) => {
      const list = visits.list.generation === noted ? visits.list.visits : [];
      visits.list = { generation: noted, visits: mergedInto(list, added) };
    }),
    visited: vi.fn(async (asked: number) =>
      visits.list.generation === asked ? [...visits.list.visits] : [],
    ),
    noteTab: vi.fn(
      async (noted: number, tabId: number, added: readonly Visit[], from?: LayoutPlace) => {
        const kept = visits.tabs.generation === noted ? visits.tabs.tabs : [];
        const tab = kept.find((each) => each.tabId === tabId);
        const place = from ?? tab?.from;
        const updated = {
          tabId,
          ...(place && { from: place }),
          visits: mergedInto(tab?.visits ?? [], added),
        };
        visits.tabs = {
          generation: noted,
          tabs: [...kept.filter((each) => each !== tab), updated],
        };
      },
    ),
    replaceTab: vi.fn(async (noted: number, removed: number, added: number) => {
      const kept = visits.tabs.generation === noted ? visits.tabs.tabs : [];
      const tabs = kept.map((each) => (each.tabId === removed ? { ...each, tabId: added } : each));
      visits.tabs = { generation: noted, tabs };
    }),
    tabVisits: vi.fn(async (asked: number) =>
      visits.tabs.generation === asked ? [...visits.tabs.tabs] : [],
    ),
    focus: { generation, windowId: undefined as number | undefined },
    noteFocus: vi.fn(async (noted: number, windowId: number) => {
      visits.focus = { generation: noted, windowId };
    }),
    focusedWindow: vi.fn(async (asked: number) =>
      visits.focus.generation === asked ? visits.focus.windowId : undefined,
    ),
  };
  return visits satisfies VisitedOrigins;
}

/** What a helper tab's agent answers to its command: replies in order, each tagged. */
type Answer = (command: { type: string }) => object[];

/**
 * Makes a helper tab's navigation commit its origin's root and connect that document's agent, which
 * answers with `answer`; the managed tab's navigations go to `managed`, when given.
 */
export function helperNavigation(
  navigation: FakeNavigationApi,
  helperTabs: ReturnType<typeof fakeHelperTabs>,
  answer: Answer,
  managed?: (tabId: number, url: string) => void,
) {
  const agents: ReturnType<typeof fakePort>[] = [];
  const update = navigation.update;
  navigation.update = async (tabId, url) => {
    await update(tabId, url);
    if (!helperTabs.opened.some((each) => each.tabId === tabId)) return managed?.(tabId, url);
    const origin = new URL(url).origin;
    const documentId = `helper-doc-${agents.length + 1}`;
    const agent = echoProbes(fakePort({ tab: { id: tabId }, frameId: 0, documentId, origin }));
    const post = agent.postMessage;
    agent.postMessage = (message: unknown) => {
      post(message);
      const { operationId, generation } = message as Record<string, unknown>;
      for (const reply of answer(message as { type: string })) {
        queueMicrotask(() => agent.onMessage.emit({ ...reply, operationId, generation }));
      }
    };
    agents.push(agent);
    navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId });
    navigation.onConnect.emit(agent);
  };
  return agents;
}

/** A capture's other origins with nothing visited: no helper tab is ever needed. */
export function noVisits() {
  return {
    visits: memoryVisits(),
    helper: { tabs: fakeHelperTabs(), barrier: fakeBarrierApi(), navigation: fakeNavigationApi() },
  };
}

/** The restored responses' URLs, in memory: one generation's at a time. */
export function memoryResponseUrls(generation = 0, initial: ResponseUrls = {}) {
  const store = {
    kept: { generation, urls: initial },
    read: vi.fn(async (asked: number) => (store.kept.generation === asked ? store.kept.urls : {})),
    write: vi.fn(async (written: number, urls: ResponseUrls) => {
      store.kept = { generation: written, urls };
    }),
  };
  return store satisfies ResponseUrlStore;
}
