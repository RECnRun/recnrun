import type {
  CookieApi,
  CookieDetails,
  CookieStore,
  StoredCookie,
} from "@/background/workspace/cookie-stores";

/** Chrome's cookie stores and tab list, as answers queued per call; `set` records each cookie. */
export interface FakeCookieApi extends CookieApi {
  /** Each `stores()` call takes the next listing; the last one repeats. */
  listings: CookieStore[][];
  normalTabs: number[];
  written: CookieDetails[];
  /** What `set` answers for a cookie name: null as Chrome does when it refuses, or a rejection. */
  refuse: Map<string, "null" | "reject">;
  /** What `all` lists for any store, or a rejection to fail with. */
  jar: StoredCookie[] | Error;
}

export function fakeCookieApi(listings: CookieStore[][], normalTabs: number[]): FakeCookieApi {
  const api: FakeCookieApi = {
    listings,
    normalTabs,
    written: [],
    refuse: new Map(),
    jar: [],
    stores: async () => (api.listings.length > 1 ? api.listings.shift() : api.listings[0]) ?? [],
    normalTabIds: async () => api.normalTabs,
    all: async () => {
      if (api.jar instanceof Error) throw api.jar;
      return api.jar;
    },
    set: async (details) => {
      const refusal = api.refuse.get(details.name);
      if (refusal === "reject") throw new Error("Failed to parse or set cookie.");
      if (refusal === "null") return false;
      api.written.push(details);
      return true;
    },
  };
  return api;
}
