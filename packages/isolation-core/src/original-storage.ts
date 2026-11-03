import { isObject, method } from "./marker-patches.ts";
import type { Method } from "./marker-patches.ts";
import { isReservedName, reservedNameRefusal } from "./original-filter.ts";

const GUARDED = ["getItem", "setItem", "removeItem"] as const;

type Natives = Record<(typeof GUARDED)[number] | "key", Method>;

function isReservedKey(property: string | symbol): boolean {
  return typeof property === "string" && isReservedName(property);
}

function refuseReserved(property: string | symbol, call: string): void {
  if (isReservedKey(property)) throw reservedNameRefusal(`localStorage.${call}`, property);
}

function nativesOf(storage: object): Natives | undefined {
  const [getItem, setItem, removeItem, key] = ["getItem", "setItem", "removeItem", "key"].map(
    (name) => method(storage, name),
  );
  if (!getItem || !setItem || !removeItem || !key) return undefined;
  return { getItem, setItem, removeItem, key };
}

/** The keys the original session sees, in the native order. */
function visibleKeys(storage: object, natives: Natives): string[] {
  const keys: string[] = [];
  const total = Number(Reflect.get(storage, "length"));
  for (let index = 0; index < total; index += 1) {
    const key: unknown = Reflect.apply(natives.key, storage, [index]);
    if (typeof key === "string" && !isReservedName(key)) keys.push(key);
  }
  return keys;
}

/** The Storage methods the proxy answers itself; each calls the native on the real storage. */
function methodsOf(storage: object, natives: Natives): Record<string, Method> {
  const methods: Record<string, Method> = {
    key: (index: unknown) => visibleKeys(storage, natives)[Number(index) >>> 0] ?? null,
    clear() {
      for (const key of visibleKeys(storage, natives)) {
        Reflect.apply(natives.removeItem, storage, [key]);
      }
    },
  };
  for (const name of GUARDED) {
    methods[name] = (...args: unknown[]) => {
      if (args.length > 0) refuseReserved(String(args[0]), name);
      return Reflect.apply(natives[name], storage, args);
    };
  }
  return methods;
}

/** `storage` as the original session sees it: reserved keys are absent and cannot be written. */
function storageProxy(storage: object, natives: Natives): object {
  const methods = methodsOf(storage, natives);
  return new Proxy(storage, {
    get(target, property) {
      if (typeof property === "string" && Object.hasOwn(methods, property)) {
        return methods[property];
      }
      if (property === "length") return visibleKeys(target, natives).length;
      return isReservedKey(property) ? undefined : Reflect.get(target, property);
    },
    set(target, property, value) {
      refuseReserved(property, "setItem");
      return Reflect.set(target, property, value);
    },
    defineProperty(target, property, descriptor) {
      refuseReserved(property, "setItem");
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      refuseReserved(property, "removeItem");
      return Reflect.deleteProperty(target, property);
    },
    has: (target, property) => !isReservedKey(property) && Reflect.has(target, property),
    ownKeys: (target) => Reflect.ownKeys(target).filter((key) => !isReservedKey(key)),
    getOwnPropertyDescriptor(target, property) {
      if (isReservedKey(property)) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

// Window defines localStorage as an own accessor ([Global] interface); a test double may inherit it.
function nativeGetter(scope: object): Method | undefined {
  for (let owner: unknown = scope; isObject(owner); owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "localStorage");
    if (!descriptor) continue;
    if (!descriptor.configurable && owner === scope) return undefined;
    return method(descriptor, "get");
  }
  return undefined;
}

/** Shadows `localStorage` with a filtered view, built on first read so a refusing origin still throws then. */
export function patchLocalStorageOriginal(scope: object): void {
  const getter = nativeGetter(scope);
  if (!getter) return;
  let view: unknown;
  Object.defineProperty(scope, "localStorage", {
    configurable: true,
    enumerable: true,
    get() {
      if (view !== undefined) return view;
      const storage: unknown = Reflect.apply(getter, scope, []);
      const natives = isObject(storage) ? nativesOf(storage) : undefined;
      view = natives && isObject(storage) ? storageProxy(storage, natives) : storage;
      return view;
    },
  });
}
