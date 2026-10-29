import { classifyIncognitoWindows } from "@recnrun/domain";
import type { ManagedWindowState } from "@recnrun/domain";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { managedWindowRepository } from "@/storage/managed-window-repository";

export type IncognitoWindow = Browser.windows.Window & { id: number };

const CLOSE_TIMEOUT_MS = 10_000;
/** How long a new window's blank page may take to load before RECnRun navigates anyway. */
export const BLANK_BOUND_MS = 5_000;

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

/**
 * Unloads every tab of the windows without running their pages' `beforeunload`, so closing them
 * never waits on a "Leave site?" dialog: a discard skips `ClosePage` (`tab_lifecycle_unit.cc:380-415`).
 */
async function discardTabs(windowIds: readonly number[]): Promise<void> {
  const listed = await Promise.all(
    windowIds.map((windowId) => browser.tabs.query({ windowId }).catch(() => [])),
  );
  const ids = listed
    .flat()
    .flatMap(({ id, discarded }) => (id === undefined || discarded ? [] : [id]));
  // A tab Chrome cannot discard is closed as before; the close timeout names a close it blocks.
  const discard = async (id: number) => {
    // Chrome throws synchronously for an argument it refuses, so the call sits inside the try.
    try {
      await browser.tabs.discard(id);
    } catch {
      return;
    }
  };
  await Promise.all(ids.map(discard));
}

/**
 * Resolves once Chrome reported every window removed and a fresh inventory no longer lists them;
 * their tabs are discarded first.
 */
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
    await discardTabs(ids);
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

/**
 * Resolves once `tabId` finished loading, or after `boundMs`, or when Chrome no longer knows it;
 * whatever navigates the tab next finds out about a tab that never loaded.
 */
export async function loaded(tabId: number, boundMs: number): Promise<void> {
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onUpdated = (id: number, change: Browser.tabs.OnUpdatedInfo) => {
    if (id === tabId && change.status === "complete") settle();
  };
  // Registered before the read, so a load that ends in between is not missed.
  browser.tabs.onUpdated.addListener(onUpdated);
  const timer = setTimeout(settle, boundMs);
  try {
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    if (tab?.status !== "loading") settle();
    await done;
  } finally {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(onUpdated);
  }
}

/**
 * Opens RECnRun's Incognito window on a blank page, only when no other Incognito window exists,
 * holding `identityId` when it is given. It returns once the blank page loaded: windows.create
 * replies while that navigation is still running, and a navigation started before it commits
 * can fail with net::ERR_ABORTED.
 */
export async function createNeutralWindow(identityId?: string): Promise<ManagedWindowState> {
  if ((await inventory()).length > 0) {
    throw new WorkspaceError(
      "IncognitoWindowsOpen",
      "Close every Incognito window before RECnRun opens its own.",
    );
  }
  const state = await managedWindowRepository.update(async (previous) => {
    const created = await browser.windows.create({ incognito: true, url: "about:blank" });
    const windowId = created?.id;
    const tabId = created?.tabs?.[0]?.id;
    if (windowId === undefined || tabId === undefined) {
      throw new WorkspaceError("WindowNotCreated", "Chrome did not open the Incognito window.");
    }
    const generation = (previous?.generation ?? 0) + 1;
    return { generation, windowId, tabId, status: "active", ...(identityId && { identityId }) };
  });
  await loaded(state.tabId, BLANK_BOUND_MS);
  return state;
}

/** Marks the session closed while it is still the one of `generation`, and nothing else. */
async function close(generation?: number): Promise<void> {
  await managedWindowRepository.update((current) => {
    const same = generation === undefined || current?.generation === generation;
    return current?.status === "active" && same ? { ...current, status: "closed" } : current;
  });
}

/** The session ends with its last Incognito window; one that closes beside others leaves it open. */
async function closeIfLast(): Promise<void> {
  const before = await managedWindowRepository.read();
  if (before?.status !== "active" || (await inventory()).length > 0) return;
  // A new session opened meanwhile has another generation, so it stays active.
  await close(before.generation);
}

/** Keeps the stored state true when the last window goes, by RECnRun, the user, or a restart. */
export function trackManagedWindow(): void {
  // An unreadable state stays as it is; the next status read reports it.
  browser.windows.onRemoved.addListener(() => void closeIfLast().catch(() => {}));
  // Incognito windows never survive a restart, and Chrome reuses window ids after one.
  browser.runtime.onStartup.addListener(() => void close().catch(() => {}));
}

/**
 * Closes every Incognito window while the session of `generation` is still active: each one is the
 * session's then. Chrome reuses window ids after a restart, so an id alone could name another.
 */
export async function closeManagedWindow(generation: number): Promise<void> {
  const managed = await managedWindowRepository.read();
  if (managed?.status !== "active" || managed.generation !== generation) return;
  const open = (await inventory()).map(({ id }) => id);
  if (open.length > 0) await closeWindows(open);
}
