import type { ManagedWindowState } from "@recnrun/domain";
import { noteIncognitoStores, waitForIncognitoGone } from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import {
  closeManagedWindow,
  closeWindows,
  createNeutralWindow,
} from "@/background/workspace/windows";
import type { IncognitoStoreMemory } from "@/ports/incognito-stores";

/** The cookie calls and the store memory that tell when Chrome destroyed an Incognito profile. */
export interface FreshWindowDeps {
  cookies: CookieApi;
  stores: IncognitoStoreMemory;
  storeBoundMs?: number;
}

/**
 * Opens the managed window only once Chrome destroyed every Incognito profile it listed, since a
 * window opened earlier would reuse the dying one with its data, then remembers the new store.
 */
export async function openFreshWindow(deps: FreshWindowDeps): Promise<ManagedWindowState> {
  await waitForIncognitoGone(deps.cookies, deps.stores, deps.storeBoundMs);
  const window = await createNeutralWindow();
  await noteIncognitoStores(deps.cookies, deps.stores);
  return window;
}

/**
 * Remembers the listed Incognito stores before a close. A failed listing does not keep a window
 * open: the next open waits through the same calls, so it fails too rather than reuse a profile.
 */
async function rememberBeforeClosing(deps: FreshWindowDeps): Promise<void> {
  await noteIncognitoStores(deps.cookies, deps.stores).catch(() => undefined);
}

/** Closes Incognito windows once their stores are remembered, so the next open waits for them. */
export async function closeRemembering(
  ids: readonly number[],
  deps: FreshWindowDeps,
): Promise<void> {
  await rememberBeforeClosing(deps);
  await closeWindows(ids);
}

/** Closes the session of `generation`, as recovery does, once its store is remembered. */
export async function closeManagedRemembering(
  generation: number,
  deps: FreshWindowDeps,
): Promise<void> {
  await rememberBeforeClosing(deps);
  await closeManagedWindow(generation);
}
