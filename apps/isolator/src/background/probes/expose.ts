import { findTarget, PROTOCOL_VERSION } from "@/background/probes/helpers";
import { PROBES, runAllProbes } from "@/background/probes/runner";
import type { DebuggerApi, ProbeResult, ProbeTargets } from "@/background/probes/types";

/** What the harness reaches with `Runtime.evaluate` in this service worker (experiment E1). */
export interface ProbeHarness {
  ids: string[];
  descriptions: Record<string, string>;
  run(urls: ProbeTargets): Promise<ProbeResult[]>;
  /** Attaches to the tab showing `pageUrl` and keeps the session, for the infobar check. */
  holdTab(pageUrl: string): Promise<number>;
  releaseTab(tabId: number): Promise<void>;
  /** Height of the tab showing `pageUrl`; a shown infobar shrinks it. */
  tabHeight(pageUrl: string): Promise<number>;
}

/** `chrome.tabs.get(tabId).height`, which needs no `tabs` permission. */
export type TabHeight = (tabId: number) => Promise<number | undefined>;

export const HARNESS_GLOBAL = "recnrunProbes";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tabShowing(api: DebuggerApi, pageUrl: string): Promise<number> {
  const tabId = findTarget(await api.getTargets(), pageUrl)?.tabId;
  if (tabId === undefined) throw new Error(`no tab shows ${pageUrl}`);
  return tabId;
}

export function createProbeHarness(
  debuggerApi: () => DebuggerApi,
  height: TabHeight,
): ProbeHarness {
  return {
    ids: PROBES.map((probe) => probe.id),
    descriptions: Object.fromEntries(PROBES.map((probe) => [probe.id, probe.description])),
    run: (urls) => runAllProbes(debuggerApi(), urls, sleep),
    holdTab: async (pageUrl) => {
      const tabId = await tabShowing(debuggerApi(), pageUrl);
      await debuggerApi().attach({ tabId }, PROTOCOL_VERSION);
      return tabId;
    },
    releaseTab: (tabId) => debuggerApi().detach({ tabId }),
    tabHeight: async (pageUrl) => {
      const tabId = await tabShowing(debuggerApi(), pageUrl);
      const value = await height(tabId);
      if (value === undefined) throw new Error(`tab ${tabId} has no height`);
      return value;
    },
  };
}

/** Installs the harness on `globalThis`; the getter defers to the moment a probe runs. */
export function exposeProbes(debuggerApi: () => DebuggerApi, height: TabHeight): void {
  Object.assign(globalThis, { [HARNESS_GLOBAL]: createProbeHarness(debuggerApi, height) });
}
