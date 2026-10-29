import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { RecordingStore } from "@/ports/recording-store";
import { managedWindowRepository } from "@/storage/managed-window-repository";

/** Shows the tab: active in its window, and that window focused. */
export async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

/** Chrome rejects an unknown id; the fake browser resolves nothing for it. */
async function openTab(tabId: number): Promise<Browser.tabs.Tab> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("The tab to record was closed.");
  return tab;
}

/** Recording targets a tab of the open Incognito session only: any of its tabs, never a normal one. */
async function ensureManaged(tab: Browser.tabs.Tab): Promise<void> {
  const managed = await managedWindowRepository.read();
  if (managed?.status !== "active" || !tab.incognito) {
    throw new Error("Only a tab of the Incognito workspace can be recorded.");
  }
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
    await ensureManaged(await openTab(tabId));
    await store.write({ tabId, status: "recording", banked: 0, since: now });
  }
  await focusTab(current?.tabId ?? tabId);
}
