import type { ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import type { VisitedOrigins } from "@/ports/visited-origins";
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
  managed: () => Promise<ManagedWindowState | null>;
  visits: Pick<VisitedOrigins, "note">;
}

const webOrigin = (url: string) => {
  const parsed = URL.parse(url);
  return parsed?.protocol === "http:" || parsed?.protocol === "https:" ? parsed.origin : undefined;
};

/** Every Incognito tab shares the identity's profile, so a top document in any of them counts. */
async function record(tracking: VisitTracking, tabId: number, origin: string): Promise<void> {
  const managed = await tracking.managed();
  if (managed?.status !== "active") return;
  if (!(await tracking.incognitoTab(tabId))) return;
  await tracking.visits.note(managed.generation, [origin]);
}

/**
 * Notes the origin of each top document an Incognito tab commits while the managed window is open,
 * so the next capture saves that origin's site data too; a failure is logged as unhandled.
 */
export function trackVisitedOrigins(tracking: VisitTracking = chromeVisitTracking()): void {
  tracking.onCommitted.addListener(({ tabId, frameId, url }) => {
    const origin = webOrigin(url);
    if (frameId === 0 && origin !== undefined) void record(tracking, tabId, origin);
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
    managed: managedWindowRepository.read,
    visits: visitedOrigins,
  };
}
