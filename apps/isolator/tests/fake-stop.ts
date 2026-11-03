import type { TargetInfo } from "@/background/probes/types";
import { StopEngine } from "@/background/stop/engine";
import type { BlockRule, StopApis, StopJournal } from "@/background/stop/types";
import { fakeDebugger } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

export const APP = "http://app.localhost:4600";
export const TAB = 7;
export const OUTSIDE_TAB = 9;
const TARGETS: TargetInfo[] = [
  { type: "page", id: "page", url: `${APP}/sw.html?sw=classic`, attached: true, tabId: TAB },
  { type: "worker", id: "sw", url: `${APP}/sw-main.js?variant=classic`, attached: true },
  { type: "worker", id: "shared", url: `${APP}/shared-worker.js?type=classic`, attached: false },
  { type: "page", id: "outside-page", url: "https://example.com/", attached: false, tabId: 9 },
  { type: "worker", id: "outside", url: "https://example.com/sw.js", attached: false },
];

interface StopOptions extends FakeOptions {
  /** Tabs `chrome.tabs.query` finds. */
  openTabs?: { id: number; url: string }[];
  /** `attach()` fails with this text, as when another session of the isolator holds the tab. */
  attachError?: string;
}

/** A match pattern of the `<origin>/*` form, the only one the eviction queries. */
function matches(pattern: string, url: string): boolean {
  return pattern.endsWith("/*") && url.startsWith(pattern.slice(0, -1));
}

/** A stop engine on a fake `chrome.debugger`, `declarativeNetRequest`, and `tabs`, with a counting clock. */
export function fakeStop(options: StopOptions = {}) {
  const fake = fakeDebugger({ targets: TARGETS, ...options });
  const rules = new Map<number, BlockRule>();
  const dnrCalls: object[] = [];
  const removedTabs: number[] = [];
  const openTabs = options.openTabs ?? [{ id: TAB, url: `${APP}/sw.html?sw=classic` }];
  const apis: StopApis = {
    debugger: {
      ...fake.api,
      attach: async (target, version) => {
        if (options.attachError) throw new Error(options.attachError);
        await fake.api.attach(target, version);
      },
    },
    dnr: {
      updateSessionRules: async (update) => {
        dnrCalls.push(update);
        for (const rule of update.addRules ?? []) rules.set(rule.id, rule);
        for (const id of update.removeRuleIds ?? []) rules.delete(id);
      },
    },
    tabs: {
      query: async ({ url }) => openTabs.filter((tab) => matches(url, tab.url)),
      remove: async (tabIds) => {
        removedTabs.push(...tabIds);
      },
    },
  };
  let clock = 0;
  const engine = new StopEngine(() => apis, { now: () => (clock += 1), timeOrigin: 1_000 });
  return { ...fake, engine, rules, dnrCalls, removedTabs };
}

/** `api.method` of every call in the journal, in order. */
export function methods(journal: Pick<StopJournal, "calls">): string[] {
  return journal.calls.map((call) => `${call.api}.${call.method}`);
}
