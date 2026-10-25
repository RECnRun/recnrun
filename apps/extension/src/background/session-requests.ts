import { browser } from "wxt/browser";
import type { RecordingStore } from "@/ports/recording-store";

/** Shows the tab: active in its window, and that window focused. */
export async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

/** Chrome rejects an unknown id; the fake browser resolves nothing for it. */
async function ensureOpen(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("The tab to record was closed.");
}

/** Records the tab unless a session runs, which it keeps, then shows the tab the session records. */
export async function startSession(
  tabId: number,
  store: RecordingStore,
  now = Date.now(),
): Promise<void> {
  // An unreadable stored session is the caller's error to show, never one to overwrite.
  const current = await store.read();
  if (current === null) {
    // A session on a closed tab could only be stopped, so none starts on one.
    await ensureOpen(tabId);
    await store.write({ tabId, status: "recording", banked: 0, since: now });
  }
  await focusTab(current?.tabId ?? tabId);
}
