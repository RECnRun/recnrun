import type { ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { isHelperTab } from "@/background/workspace/helper-tab";
import type { Visit, VisitedOrigins } from "@/ports/visited-origins";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { visitedOrigins } from "@/storage/visited-origins";

interface Commit {
  tabId: number;
  frameId: number;
  url: string;
}

/** What the tracking needs from Chrome and storage; tests replace each. */
export interface VisitTracking {
  onCommitted: { addListener: (listener: (commit: Commit) => void) => void };
  /** Whether the tab is an Incognito one; false for a tab Chrome no longer knows. */
  incognitoTab: (tabId: number) => Promise<boolean>;
  /** Whether the tab is a capture's or a start's own helper tab, whose pages are not the user's. */
  helperTab: (tabId: number) => boolean;
  managed: () => Promise<ManagedWindowState | null>;
  visits: Pick<VisitedOrigins, "note">;
}

/** The page's origin and path; the query and fragment are dropped, since they can carry tokens. */
const webVisit = (url: string): Visit | undefined => {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") return undefined;
  return { origin: parsed.origin, url: `${parsed.origin}${parsed.pathname}` };
};

/** Every Incognito tab shares the identity's profile, so a top document in any of them counts. */
async function record(tracking: VisitTracking, tabId: number, visit: Visit): Promise<void> {
  const managed = await tracking.managed();
  if (managed?.status !== "active") return;
  if (!(await tracking.incognitoTab(tabId))) return;
  await tracking.visits.note(managed.generation, [visit]);
}

/**
 * Notes the origin and page of each top document an Incognito tab commits while the managed window
 * is open, so the next capture saves that origin's site data too; a failure is logged as unhandled.
 */
export function trackVisitedOrigins(tracking: VisitTracking = chromeVisitTracking()): void {
  tracking.onCommitted.addListener(({ tabId, frameId, url }) => {
    const visit = webVisit(url);
    // Read now: a helper tab is forgotten once it closes, before a late record would ask.
    if (frameId === 0 && visit !== undefined && !tracking.helperTab(tabId)) {
      void record(tracking, tabId, visit);
    }
  });
}

/** Chrome's navigation events and tabs, the managed window's state, and the session list. */
function chromeVisitTracking(): VisitTracking {
  return {
    onCommitted: browser.webNavigation.onCommitted,
    incognitoTab: async (tabId) => {
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      return tab?.incognito === true;
    },
    helperTab: isHelperTab,
    managed: managedWindowRepository.read,
    visits: visitedOrigins,
  };
}
