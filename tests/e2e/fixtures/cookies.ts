import type { Worker } from "@playwright/test";

/** A cookie as `cookies.getAll` lists it, without the store it came from. */
export interface ListedCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}

interface CookiesGlobal {
  chrome: {
    cookies: {
      getAllCookieStores: () => Promise<{ id: string }[]>;
      getAll: (filter: object) => Promise<(ListedCookie & { storeId: string })[]>;
      set: (details: object) => Promise<unknown>;
    };
  };
}

/** Every cookie of the Incognito store, partitioned ones included, in a stable order. */
export const incognitoJar = (serviceWorker: Worker): Promise<ListedCookie[]> =>
  serviceWorker.evaluate(async () => {
    const { cookies } = (globalThis as unknown as CookiesGlobal).chrome;
    // The normal profile's store is always "0"; the one other store is Incognito's.
    const store = (await cookies.getAllCookieStores()).find(({ id }) => id !== "0");
    if (!store) throw new Error("Chrome lists no Incognito cookie store.");
    const listed = await cookies.getAll({ storeId: store.id, partitionKey: {} });
    const keyOf = (cookie: ListedCookie) => `${cookie.domain} ${cookie.path} ${cookie.name}`;
    return listed
      .map(({ storeId: _store, ...cookie }) => cookie)
      .toSorted((a, b) => keyOf(a).localeCompare(keyOf(b)));
  });

/** `cookie (name) on domain/path`, the way a capture names a cookie it does not keep. */
export const named = (cookies: readonly ListedCookie[]) =>
  cookies.map(({ name, domain, path }) => `${name} on ${domain}${path}`);

/** How Chrome answered one `cookies.set`: the cookie it set, none, or its error. */
type SetOutcome = "set" | "none" | `threw: ${string}`;

/** Runs each `cookies.set` call in the Incognito store and reports how Chrome answered it. */
export const setOutcomes = (serviceWorker: Worker, cases: Record<string, object>) =>
  serviceWorker.evaluate(async (all) => {
    const { cookies } = (globalThis as unknown as CookiesGlobal).chrome;
    const store = (await cookies.getAllCookieStores()).find(({ id }) => id !== "0");
    const outcomes: Record<string, string> = {};
    for (const [name, details] of Object.entries(all)) {
      try {
        const set = await cookies.set({ storeId: store?.id, ...details });
        // Chrome resolves with no value, not null, when it stored no cookie.
        outcomes[name] = set === null || set === undefined ? "none" : "set";
      } catch (error) {
        outcomes[name] = `threw: ${(error as Error).message}`;
      }
    }
    return outcomes as Record<string, SetOutcome>;
  }, cases);
