import {
  cacheNativesOf,
  isObject,
  matchOwned,
  method,
  replace,
  wrapMethods,
} from "./marker-patches.ts";
import type { CacheView } from "./marker-patches.ts";
import { isReservedName, reservedNameRefusal, visibleToOriginal } from "./original-filter.ts";

/** Refuses a reserved first argument before the native sees it: thrown, or rejected for promise APIs. */
function guardFirstArgument(target: object, api: string, names: string[], rejects: boolean) {
  wrapMethods(
    target,
    names,
    (native, name) =>
      function (this: unknown, ...args: unknown[]) {
        if (args.length > 0 && isReservedName(args[0])) {
          const refusal = reservedNameRefusal(`${api}.${name}`, args[0]);
          if (rejects) return Promise.reject(refusal);
          throw refusal;
        }
        return Reflect.apply(native, this, args);
      },
  );
}

/** Replaces `name` with the native's result without the reserved names. */
function filterResult(target: object, name: string): void {
  const native = method(target, name);
  if (!native) return;
  replace(target, name, function (this: unknown) {
    return Promise.resolve(Reflect.apply(native, this, [])).then(visibleToOriginal);
  });
}

export function patchIndexedDbOriginal(scope: object): void {
  const factory: unknown = Reflect.get(scope, "indexedDB");
  if (!isObject(factory)) return;
  guardFirstArgument(factory, "indexedDB", ["open", "deleteDatabase"], false);
  filterResult(factory, "databases");
}

const ORIGINAL_VIEW: CacheView = {
  owns: (name) => !isReservedName(name),
  physical(cacheName) {
    if (isReservedName(cacheName)) throw reservedNameRefusal("caches.match", cacheName);
    return cacheName;
  },
};

export function patchCachesOriginal(scope: object): void {
  const storage: unknown = Reflect.get(scope, "caches");
  if (!isObject(storage)) return;
  const natives = cacheNativesOf(storage);
  guardFirstArgument(storage, "caches", ["open", "has", "delete"], true);
  filterResult(storage, "keys");
  if (!natives) return;
  replace(storage, "match", function (this: unknown, ...args: unknown[]) {
    return matchOwned(this, natives, ORIGINAL_VIEW, args);
  });
}
