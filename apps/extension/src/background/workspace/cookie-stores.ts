import type { SiteCookie } from "@recnrun/domain";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";

/** A cookie store as Chrome lists it: its id and the tabs that use it. */
export interface CookieStore {
  id: string;
  tabIds: number[];
}

/** One `cookies.set` call: the cookie, the store it goes into, and the URL that scopes it. */
export type CookieDetails = Omit<SiteCookie, "host"> & { storeId: string; url: string };

/** A cookie as `cookies.getAll` lists it; `hostOnly` and `session` are not `cookies.set` fields. */
export type StoredCookie = Omit<SiteCookie, "host"> & {
  domain: string;
  hostOnly: boolean;
  session: boolean;
};

/** The cookie and tab calls the workspace needs, behind a port so tests can fake Chrome's answers. */
export interface CookieApi {
  stores: () => Promise<CookieStore[]>;
  normalTabIds: () => Promise<number[]>;
  /** Every cookie of `storeId`, partitioned ones included, that the host permissions reach. */
  all: (storeId: string) => Promise<StoredCookie[]>;
  /** False when Chrome refused the cookie. */
  set: (details: CookieDetails) => Promise<boolean>;
}

/** How long a closed Incognito profile may stay listed before a start gives up. */
const STORE_GONE_BOUND_MS = 10_000;

/**
 * Waits until Chrome lists no Incognito cookie store, the closest sign that it destroyed the last
 * Incognito profile. Chrome fires no event for it, so each answer leads to the next question.
 * Resolves with the number of listings it took.
 */
export async function waitForNoIncognitoStore(
  api: CookieApi,
  boundMs = STORE_GONE_BOUND_MS,
): Promise<number> {
  const deadline = performance.now() + boundMs;
  for (let checks = 1; ; checks += 1) {
    // The normal profile always lists its store, even with no tab; any other store is Incognito's.
    if ((await api.stores()).length <= 1) return checks;
    if (performance.now() >= deadline) {
      throw new WorkspaceError(
        "IncognitoNotGone",
        "Chrome still holds the previous Incognito data; try again.",
      );
    }
  }
}

/** The cookie store of the managed tab, never a guessed id nor the normal store. */
export async function resolveTabStore(
  api: Pick<CookieApi, "stores" | "normalTabIds">,
  tabId: number,
): Promise<string> {
  const normal = new Set(await api.normalTabIds());
  const store = (await api.stores()).find(({ tabIds }) => tabIds.includes(tabId));
  if (store === undefined || store.tabIds.some((id) => normal.has(id))) {
    throw new WorkspaceError(
      "CookieStoreNotFound",
      "Chrome lists no Incognito cookie store for the workspace tab.",
    );
  }
  return store.id;
}

/** The URL Chrome scopes a cookie by: its domain, else its own host, else the target's host. */
function cookieUrl(origin: string, cookie: SiteCookie): string {
  const target = new URL(origin);
  const host = cookie.domain?.replace(/^\./, "") ?? cookie.host;
  if (host !== undefined) target.hostname = host;
  return `${target.origin}${cookie.path}`;
}

/** Chrome stores no cookie set past its expiry, and answers with none, as if it refused it. */
const expired = ({ expirationDate }: SiteCookie, nowSeconds: number) =>
  expirationDate !== undefined && expirationDate <= nowSeconds;

async function setOne(api: CookieApi, details: CookieDetails): Promise<boolean> {
  try {
    return await api.set(details);
  } catch {
    return false;
  }
}

/**
 * Sets each cookie in `storeId`, in order, but those expired since their capture, and counts what it
 * set; diagnostics name the cookie, never its value.
 */
export async function restoreCookies(
  api: CookieApi,
  storeId: string,
  origin: string,
  cookies: readonly SiteCookie[],
): Promise<number> {
  const live = cookies.filter((cookie) => !expired(cookie, Date.now() / 1000));
  for (const cookie of live) {
    const { host: _host, ...details } = cookie;
    if (!(await setOne(api, { ...details, storeId, url: cookieUrl(origin, cookie) }))) {
      throw new WorkspaceError("CookieNotSet", `Chrome refused the cookie "${cookie.name}".`);
    }
  }
  return live.length;
}

/** The cookie calls through Chrome; `cookies` exists only in builds that ask for it. */
export const chromeCookieApi: CookieApi = {
  stores: async () =>
    (await browser.cookies.getAllCookieStores()).map(({ id, tabIds }) => ({ id, tabIds })),
  normalTabIds: async () =>
    (await browser.tabs.query({}))
      .filter((tab) => !tab.incognito)
      .flatMap(({ id }) => (id === undefined ? [] : [id])),
  // An empty partition key lists every partition's cookies and the unpartitioned ones.
  all: async (storeId) =>
    (await browser.cookies.getAll({ storeId, partitionKey: {} })) as StoredCookie[],
  // Chrome answers null, or no value at all, when it stored no cookie.
  set: async (details) => Boolean(await browser.cookies.set(details as Browser.cookies.SetDetails)),
};
