import { logicalName, markUrl, physicalName } from "./marker.ts";

export type Method = (this: unknown, ...args: unknown[]) => unknown;
type Constructor = new (...args: unknown[]) => unknown;

export function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function method(target: unknown, name: string): Method | undefined {
  if (!isObject(target)) return undefined;
  const value: unknown = Reflect.get(target, name);
  return typeof value === "function" ? (value as Method) : undefined;
}

// An own property shadows the prototype's method without touching the shared prototype.
export function replace(target: object, name: string, value: Method): void {
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

function href(scope: object): string | undefined {
  const location: unknown = Reflect.get(scope, "location");
  const value: unknown = isObject(location) ? Reflect.get(location, "href") : undefined;
  return typeof value === "string" ? value : undefined;
}

function markRequest(request: object, marker: string, RequestClass: Constructor, base?: string) {
  const url: unknown = Reflect.get(request, "url");
  if (typeof url !== "string") return request;
  try {
    return new RequestClass(markUrl(url, marker, base), request);
  } catch {
    // A navigation Request cannot be copied (Fetch spec), so it goes out unmarked.
    return request;
  }
}

function markInput(input: unknown, marker: string, scope: object): unknown {
  const RequestClass: unknown = Reflect.get(scope, "Request");
  if (typeof RequestClass === "function" && input instanceof RequestClass) {
    return markRequest(input, marker, RequestClass as Constructor, href(scope));
  }
  if (typeof input === "string" || input instanceof URL) {
    return markUrl(String(input), marker, href(scope));
  }
  return input;
}

export function patchFetch(scope: object, marker: string): void {
  const native = method(scope, "fetch");
  if (!native) return;
  replace(scope, "fetch", function fetch(this: unknown, input: unknown, ...rest: unknown[]) {
    return Reflect.apply(native, this, [markInput(input, marker, scope), ...rest]);
  });
}

/** Replaces each method of `target` in `names` with what `wrap` builds around its native. */
export function wrapMethods(
  target: object,
  names: string[],
  wrap: (native: Method, name: string) => Method,
): void {
  for (const name of names) {
    const native = method(target, name);
    if (native) replace(target, name, wrap(native, name));
  }
}

/** Rewrites the first argument of each method from a logical to a physical name. */
function renameFirstArgument(target: object, names: string[], marker: string): void {
  wrapMethods(
    target,
    names,
    (native) =>
      function (this: unknown, ...args: unknown[]) {
        if (args.length > 0) args[0] = physicalName(marker, String(args[0]));
        return Reflect.apply(native, this, args);
      },
  );
}

export function nameOf(entry: unknown): unknown {
  return isObject(entry) ? Reflect.get(entry, "name") : entry;
}

function ownLogical(entries: unknown, marker: string): unknown[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    const name = nameOf(entry);
    const logical = typeof name === "string" ? logicalName(marker, name) : undefined;
    if (logical === undefined) return [];
    return [isObject(entry) ? { ...entry, name: logical } : logical];
  });
}

export function patchIndexedDb(scope: object, marker: string): void {
  const factory: unknown = Reflect.get(scope, "indexedDB");
  if (!isObject(factory)) return;
  const databases = method(factory, "databases");
  renameFirstArgument(factory, ["open", "deleteDatabase"], marker);
  if (!databases) return;
  replace(factory, "databases", function (this: unknown) {
    return Promise.resolve(Reflect.apply(databases, this, [])).then((list) =>
      ownLogical(list, marker),
    );
  });
}

export interface CacheNatives {
  keys: Method;
  open: Method;
  match: Method;
}

/** Which physical caches a scope sees, and the physical name of a `cacheName` it asks for. */
export interface CacheView {
  owns(physical: string): boolean;
  physical(cacheName: string): string;
}

/** `caches.match` limited to the caches `view` owns, searched in creation order like the native. */
export async function matchOwned(
  storage: unknown,
  natives: CacheNatives,
  view: CacheView,
  args: unknown[],
) {
  const [request, options] = args;
  const cacheName: unknown = isObject(options) ? Reflect.get(options, "cacheName") : undefined;
  if (typeof cacheName === "string") {
    const physical = { ...(options as object), cacheName: view.physical(cacheName) };
    return Reflect.apply(natives.match, storage, [request, physical]) as unknown;
  }
  const names: unknown = await Reflect.apply(natives.keys, storage, []);
  const own = Array.isArray(names) ? names.filter((name: unknown) => view.owns(String(name))) : [];
  for (const name of own) {
    const cache: unknown = await Reflect.apply(natives.open, storage, [name]);
    const found: unknown = await method(cache, "match")?.call(cache, request, options);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The natives `matchOwned` needs, read before any patch replaces them. */
export function cacheNativesOf(storage: object): CacheNatives | undefined {
  const [keys, open, match] = ["keys", "open", "match"].map((name) => method(storage, name));
  return keys && open && match ? { keys, open, match } : undefined;
}

export function patchCaches(scope: object, marker: string): void {
  const storage: unknown = Reflect.get(scope, "caches");
  if (!isObject(storage)) return;
  const natives = cacheNativesOf(storage);
  renameFirstArgument(storage, ["open", "has", "delete"], marker);
  if (!natives) return;
  const { keys } = natives;
  replace(storage, "keys", function (this: unknown) {
    return Promise.resolve(Reflect.apply(keys, this, [])).then((names) =>
      ownLogical(names, marker),
    );
  });
  replace(storage, "match", function (this: unknown, ...args: unknown[]) {
    const view: CacheView = {
      owns: (name) => logicalName(marker, name) !== undefined,
      physical: (name) => physicalName(marker, name),
    };
    return matchOwned(this, natives, view, args);
  });
}
