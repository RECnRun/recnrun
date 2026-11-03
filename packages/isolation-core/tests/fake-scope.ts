/** A worker-like global with recording fakes of `fetch`, `indexedDB`, and `caches`. */
export interface FakeScope {
  scope: Record<string, unknown>;
  /** The arguments of every native `fetch` call. */
  fetched: unknown[][];
  /** Every native `indexedDB` and `caches` call, as "<api>.<method> <name>". */
  calls: string[];
}

type Entries = Map<string, Map<string, string>>;

function fakeIndexedDb(databases: string[], calls: string[]) {
  return {
    open(...args: unknown[]) {
      calls.push(`indexedDB.open ${args.map(String).join(" ")}`);
      return { readyState: "pending" };
    },
    deleteDatabase(name: string) {
      calls.push(`indexedDB.deleteDatabase ${name}`);
      return { readyState: "pending" };
    },
    databases() {
      return Promise.resolve(databases.map((name) => ({ name, version: 1 })));
    },
  };
}

function fakeCache(responses: Map<string, string>) {
  return {
    match(request: unknown) {
      return Promise.resolve(responses.get(String(request)));
    },
  };
}

function fakeCaches(entries: Entries, calls: string[]) {
  return {
    open(name: string) {
      calls.push(`caches.open ${name}`);
      const responses = entries.get(name) ?? new Map<string, string>();
      entries.set(name, responses);
      return Promise.resolve(fakeCache(responses));
    },
    has(name: string) {
      calls.push(`caches.has ${name}`);
      return Promise.resolve(entries.has(name));
    },
    delete(name: string) {
      calls.push(`caches.delete ${name}`);
      return Promise.resolve(entries.delete(name));
    },
    keys() {
      return Promise.resolve([...entries.keys()]);
    },
    match(request: unknown, options?: { cacheName?: string }) {
      calls.push(`caches.match ${options?.cacheName ?? "*"}`);
      // Without a cacheName, Cache Storage searches every cache in creation order.
      const searched = options?.cacheName ? [entries.get(options.cacheName)] : entries.values();
      for (const responses of searched) {
        const found = responses?.get(String(request));
        if (found !== undefined) return Promise.resolve(found);
      }
      return Promise.resolve(undefined);
    },
  };
}

export interface FakeScopeOptions {
  href?: string;
  databases?: string[];
  /** Cache name to (request URL to response body). */
  caches?: Record<string, Record<string, string>>;
  Request?: unknown;
}

export function fakeScope(options: FakeScopeOptions = {}): FakeScope {
  const fetched: unknown[][] = [];
  const calls: string[] = [];
  const entries: Entries = new Map(
    Object.entries(options.caches ?? {}).map(([name, map]) => [name, new Map(Object.entries(map))]),
  );
  const scope: Record<string, unknown> = {
    location: { href: options.href ?? "http://app.localhost:4600/sw-main.js?variant=classic" },
    Request: options.Request ?? Request,
    fetch(...args: unknown[]) {
      fetched.push(args);
      return Promise.resolve({ ok: true });
    },
    indexedDB: fakeIndexedDb(options.databases ?? [], calls),
    caches: fakeCaches(entries, calls),
  };
  return { scope, fetched, calls };
}

/** Calls `name` on the object at `scope[api]`, the way worker code would. */
export function call(
  scope: Record<string, unknown>,
  api: string,
  name: string,
  ...args: unknown[]
) {
  const target: unknown = api === "" ? scope : scope[api];
  const method: unknown = Reflect.get(target as object, name);
  if (typeof method !== "function") throw new Error(`${api}.${name} is not a function`);
  return Reflect.apply(method, target, args) as unknown;
}
