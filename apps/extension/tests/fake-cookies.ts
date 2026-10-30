import type {
  CookieApi,
  CookieDetails,
  CookieStore,
  StoredCookie,
} from "@/background/workspace/cookie-stores";
import type { IncognitoStoreMemory } from "@/ports/incognito-stores";

/** Chrome's cookie stores and tab list, as answers queued per call; `set` records each cookie. */
export interface FakeCookieApi extends CookieApi {
  /** Each `stores()` call takes the next listing; the last one repeats. */
  listings: CookieStore[][];
  normalTabs: number[];
  incognitoTabs: number[];
  /** Per store id, what each `probe` answers in turn (the last repeats); an unknown id is gone. */
  alive: Map<string, boolean[]>;
  /** Every probed id, in order. */
  probes: string[];
  written: CookieDetails[];
  /** What `set` answers for a cookie name: null as Chrome does when it refuses, or a rejection. */
  refuse: Map<string, "null" | "reject">;
  /** What `all` lists for any store, or a rejection to fail with. */
  jar: StoredCookie[] | Error;
}

const next = <T>(queue: T[]): T | undefined => (queue.length > 1 ? queue.shift() : queue[0]);

export function fakeCookieApi(
  listings: CookieStore[][],
  normalTabs: number[],
  incognitoTabs: number[] = [],
): FakeCookieApi {
  const api: FakeCookieApi = {
    listings,
    normalTabs,
    incognitoTabs,
    alive: new Map(),
    probes: [],
    written: [],
    refuse: new Map(),
    jar: [],
    stores: async () => next(api.listings) ?? [],
    normalTabIds: async () => api.normalTabs,
    incognitoTabIds: async () => api.incognitoTabs,
    probe: async (storeId) => {
      api.probes.push(storeId);
      return next(api.alive.get(storeId) ?? []) ?? false;
    },
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

/** The Incognito store ids RECnRun remembers, in memory. */
export function memoryStoreMemory(
  initial: string[] = [],
): IncognitoStoreMemory & { ids: string[] } {
  const memory = {
    ids: [...initial],
    read: async () => [...memory.ids],
    remember: async (ids: readonly string[]) => {
      for (const id of ids) if (!memory.ids.includes(id)) memory.ids.push(id);
    },
  };
  return memory;
}
