/*
 * `@/p2p/p2p-database` in memory, for Node tests where IndexedDB does not exist:
 * `vi.mock("@/p2p/p2p-database", () => import("./memory-p2p-database"))`.
 */

const stores = new Map<string, Map<string, unknown>>();

const storeOf = (name: string) => {
  let store = stores.get(name);
  if (!store) {
    store = new Map();
    stores.set(name, store);
  }
  return store;
};

export const readStored = async (store: string, key: string): Promise<unknown> =>
  storeOf(store).get(key);

export const writeStored = async (store: string, key: string, value: unknown): Promise<void> =>
  void storeOf(store).set(key, value);

export const addStored = async (store: string, key: string, value: unknown): Promise<boolean> => {
  if (storeOf(store).has(key)) return false;
  storeOf(store).set(key, value);
  return true;
};

export const deleteStored = async (store: string, key: string): Promise<void> =>
  void storeOf(store).delete(key);

/** The keys each store holds now, for assertions. */
export const storedKeys = (store: string): string[] => [...storeOf(store).keys()].sort();

export const resetStored = (): void => stores.clear();
