import type { SiteCookie } from "@recnrun/domain";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { workspaceUnavailable } from "@/background/workspace/availability";
import { WorkspaceError } from "@/background/workspace/errors";
import type { IncognitoStoreMemory } from "@/ports/incognito-stores";

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
  incognitoTabIds: () => Promise<number[]>;
  /** Whether Chrome still knows `storeId`: true while its profile exists, even with no tab left. */
  probe: (storeId: string) => Promise<boolean>;
  /** Every cookie of `storeId`, partitioned ones included, that the host permissions reach. */
  all: (storeId: string) => Promise<StoredCookie[]>;
  /** False when Chrome refused the cookie. */
  set: (details: CookieDetails) => Promise<boolean>;
}

/** How long a closed Incognito profile may stay alive before a start gives up. */
const STORE_GONE_BOUND_MS = 10_000;

/** The listed stores, split into those Chrome may still keep alive and those proven Incognito. */
async function classifyStores(api: Pick<CookieApi, "stores" | "normalTabIds" | "incognitoTabIds">) {
  // Stores first: every tab a store lists then existed before the tab queries that follow.
  const stores = await api.stores();
  const normal = new Set(await api.normalTabIds());
  const incognito = new Set(await api.incognitoTabIds());
  const isNormal = ({ tabIds }: CookieStore) =>
    tabIds.length > 0 && tabIds.every((id) => normal.has(id));
  const isIncognito = ({ tabIds }: CookieStore) =>
    tabIds.length > 0 && tabIds.every((id) => incognito.has(id));
  return {
    blocking: stores.filter((store) => !isNormal(store)),
    incognito: stores.filter(isIncognito).map(({ id }) => id),
  };
}

/**
 * Remembers every listed store whose tabs are all Incognito, so a later wait can probe it once its
 * last tab is gone. A store with a tab of unknown kind is left out: remembering the normal store
 * would make every wait run out. Resolves with the ids it saw.
 */
export async function noteIncognitoStores(
  api: Pick<CookieApi, "stores" | "normalTabIds" | "incognitoTabIds">,
  memory: IncognitoStoreMemory,
): Promise<string[]> {
  const { incognito } = await classifyStores(api);
  if (incognito.length > 0) await memory.remember(incognito);
  return incognito;
}

/**
 * Remembers the store of each new Incognito tab, so a window the user opens and closes between two
 * commands is still waited for. Chrome lists a store only while it has a tab (`cookies_api.cc:895`),
 * and dispatches `tabs.onCreated` once the tab is in its window (`tabs_event_router.cc:461-471`).
 */
export function trackIncognitoStores(
  api: Pick<CookieApi, "stores" | "normalTabIds" | "incognitoTabIds">,
  memory: IncognitoStoreMemory,
): void {
  browser.tabs.onCreated.addListener(({ incognito }) => {
    // Nothing waits on this listing; a failed one, or a build without `cookies`, leaves the next.
    if (incognito) noteIncognitoStores(api, memory).catch(() => undefined);
  });
}

async function anyAlive(api: Pick<CookieApi, "probe">, ids: readonly string[]): Promise<boolean> {
  for (const id of ids) if (await api.probe(id)) return true;
  return false;
}

/**
 * Waits until Chrome lists no Incognito store and no longer knows any Incognito store it ever
 * listed. Chrome unlists a store with its last tab, but destroys the Incognito profile only once
 * its renderers exit, and until then a new Incognito window reuses that profile. Chrome fires no
 * event for either, so each answer leads to the next question. Resolves with the checks it took.
 */
export async function waitForIncognitoGone(
  api: CookieApi,
  memory: IncognitoStoreMemory,
  boundMs = STORE_GONE_BOUND_MS,
): Promise<number> {
  const deadline = performance.now() + boundMs;
  for (let checks = 1; ; checks += 1) {
    const { blocking, incognito } = await classifyStores(api);
    if (incognito.length > 0) await memory.remember(incognito);
    if (blocking.length === 0 && !(await anyAlive(api, await memory.read()))) return checks;
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

/** Chrome's cookies API, which only builds that ask for the `cookies` permission have. */
function cookiesApi(): typeof browser.cookies {
  const { cookies } = browser as Partial<typeof browser>;
  if (cookies === undefined) throw workspaceUnavailable();
  return cookies;
}

async function tabIds(incognito: boolean): Promise<number[]> {
  return (await browser.tabs.query({}))
    .filter((tab) => tab.incognito === incognito)
    .flatMap(({ id }) => (id === undefined ? [] : [id]));
}

// Chrome's text for a store whose profile is gone (cookies_api.cc).
const UNKNOWN_STORE = "Invalid cookie store id";

/** The cookie calls through Chrome; `cookies` exists only in builds that ask for it. */
export const chromeCookieApi: CookieApi = {
  stores: async () =>
    (await cookiesApi().getAllCookieStores()).map(({ id, tabIds }) => ({ id, tabIds })),
  normalTabIds: () => tabIds(false),
  incognitoTabIds: () => tabIds(true),
  // The domain matches no cookie, so the answer carries none; only the store id is checked.
  probe: async (storeId) => {
    const cookies = cookiesApi();
    try {
      await cookies.getAll({ storeId, domain: "recnrun.invalid" });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(UNKNOWN_STORE)) return false;
      throw error;
    }
  },
  // An empty partition key lists every partition's cookies and the unpartitioned ones.
  all: async (storeId) =>
    (await cookiesApi().getAll({ storeId, partitionKey: {} })) as StoredCookie[],
  // Chrome answers null, or no value at all, when it stored no cookie.
  set: async (details) => Boolean(await cookiesApi().set(details as Browser.cookies.SetDetails)),
};
