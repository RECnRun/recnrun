import { classifyIncognitoWindows } from "@recnrun/domain";
import type { ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { managedWindowRepository } from "@/storage/managed-window-repository";

export type IncognitoWindow = Browser.windows.Window & { id: number };

const CLOSE_TIMEOUT_MS = 10_000;

/** The Incognito windows this extension sees, with their tabs; titles and URLs stay in memory. */
export async function inventory(): Promise<IncognitoWindow[]> {
  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ["normal", "popup"],
  });
  // windows.getAll always assigns ids; only windows from the sessions API lack one.
  const identified = windows.filter((each): each is IncognitoWindow => each.id !== undefined);
  return classifyIncognitoWindows(identified, undefined).foreign;
}

function within(promise: Promise<void>, timeoutMs: number, error: () => Error): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Resolves once Chrome reported every window removed and a fresh inventory no longer lists them. */
export async function closeWindows(
  ids: readonly number[],
  timeoutMs = CLOSE_TIMEOUT_MS,
): Promise<void> {
  const pending = new Set(ids);
  let settle = () => {};
  const removed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onRemoved = (id: number) => {
    pending.delete(id);
    if (pending.size === 0) settle();
  };
  // Registered before the first remove, so no removal goes unseen.
  browser.windows.onRemoved.addListener(onRemoved);
  try {
    if (pending.size === 0) settle();
    // Chrome rejects an id it no longer knows; the inventory below decides whether it is gone.
    await Promise.all(ids.map((id) => browser.windows.remove(id).catch(() => onRemoved(id))));
    const late = () =>
      new WorkspaceError("WindowsNotClosed", "Chrome did not close the Incognito windows in time.");
    await within(removed, timeoutMs, late);
    const left = (await inventory()).filter((window) => ids.includes(window.id));
    if (left.length > 0) {
      throw new WorkspaceError("WindowsNotClosed", "Some Incognito windows are still open.");
    }
  } finally {
    browser.windows.onRemoved.removeListener(onRemoved);
  }
}

/** Opens RECnRun's Incognito window on a blank page, only when no other Incognito window exists. */
export async function createNeutralWindow(): Promise<ManagedWindowState> {
  if ((await inventory()).length > 0) {
    throw new WorkspaceError(
      "IncognitoWindowsOpen",
      "Close every Incognito window before RECnRun opens its own.",
    );
  }
  return managedWindowRepository.update(async (previous) => {
    const created = await browser.windows.create({ incognito: true, url: "about:blank" });
    const windowId = created?.id;
    const tabId = created?.tabs?.[0]?.id;
    if (windowId === undefined || tabId === undefined) {
      throw new WorkspaceError("WindowNotCreated", "Chrome did not open the Incognito window.");
    }
    const generation = (previous?.generation ?? 0) + 1;
    return { generation, windowId, tabId, status: "active" };
  });
}

function markClosed(windowId?: number): void {
  // An unreadable state stays as it is; the next status read reports it.
  void managedWindowRepository
    .update((current) => {
      const gone = windowId === undefined || current?.windowId === windowId;
      return current?.status === "active" && gone ? { ...current, status: "closed" } : current;
    })
    .catch(() => {});
}

/** Keeps the stored state true when the window goes, by RECnRun, the user, or a browser restart. */
export function trackManagedWindow(): void {
  browser.windows.onRemoved.addListener((windowId) => markClosed(windowId));
  // Incognito windows never survive a restart, and Chrome reuses window ids after one.
  browser.runtime.onStartup.addListener(() => markClosed());
}
