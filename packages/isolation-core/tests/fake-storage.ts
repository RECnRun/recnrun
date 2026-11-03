/** A Web Storage stand-in: items are own enumerable properties, the methods live on its prototype. */
export interface FakeStorage {
  storage: Record<string, unknown>;
  /** The keys the storage physically holds, read past any patch. */
  physicalKeys(): string[];
}

type Items = Record<string, string>;

const PROTOTYPE = {
  getItem(this: Items, key: unknown): string | null {
    const name = String(key);
    return Object.hasOwn(this, name) ? (this[name] ?? null) : null;
  },
  setItem(this: Items, key: unknown, value: unknown): void {
    this[String(key)] = String(value);
  },
  removeItem(this: Items, key: unknown): void {
    Reflect.deleteProperty(this, String(key));
  },
  key(this: Items, index: number): string | null {
    return Object.keys(this)[index] ?? null;
  },
  clear(this: Items): void {
    for (const key of Object.keys(this)) Reflect.deleteProperty(this, key);
  },
  get length(): number {
    return Object.keys(this).length;
  },
};

export function fakeStorage(items: Items = {}): FakeStorage {
  const storage = Object.assign(Object.create(PROTOTYPE) as Items, items);
  return { storage, physicalKeys: () => Object.keys(storage) };
}

/** Puts `storage` behind a `localStorage` getter on the prototype of `scope`, as Window does. */
export function withLocalStorage(scope: Record<string, unknown>, storage: object): void {
  const prototype = Object.create(Object.getPrototypeOf(scope) as object) as object;
  Object.defineProperty(prototype, "localStorage", { get: () => storage, configurable: true });
  Object.setPrototypeOf(scope, prototype);
}
