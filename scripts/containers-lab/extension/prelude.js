// The MAIN-world prelude (Layer 2) for storage and channels; prelude-identity.js adds workers and
// cookies. A classic script: B1 sends its parts' text through the debugger, and the control tabs'
// content script runs it directly. Each part is self-contained, since its text runs elsewhere. A
// container sees only names under its prefix, without it; a control tab sees every name except
// the containers'.
(() => {
  function storagePart(ns) {
    if (typeof Storage === "undefined") return;
    const proto = Storage.prototype;
    const raw = {
      get: ns.original(proto, "getItem"),
      set: ns.original(proto, "setItem"),
      remove: ns.original(proto, "removeItem"),
      key: ns.original(proto, "key"),
    };
    const rawLength = ns.getter(proto, "length");
    const ownKeys = (storage) => {
      const keys = [];
      for (let index = 0; index < rawLength.call(storage); index += 1)
        keys.push(ns.unwrap(raw.key.call(storage, index)));
      return keys.filter((key) => key !== null);
    };
    proto.getItem = function getItem(key) {
      return raw.get.call(this, ns.wrap(key));
    };
    proto.setItem = function setItem(key, value) {
      raw.set.call(this, ns.wrap(key), value);
    };
    proto.removeItem = function removeItem(key) {
      raw.remove.call(this, ns.wrap(key));
    };
    proto.key = function key(index) {
      return ownKeys(this)[index] ?? null;
    };
    proto.clear = function clear() {
      for (const key of ownKeys(this)) raw.remove.call(this, ns.wrap(key));
    };
    Object.defineProperty(proto, "length", {
      get: function length() {
        return ownKeys(this).length;
      },
      configurable: true,
    });
    ns.storageKeys = ownKeys;
  }

  /** `localStorage.marker` and `Object.keys(localStorage)` go through the namespaced methods too. */
  function storageAccessPart(ns) {
    if (typeof Storage === "undefined" || typeof window === "undefined") return;
    const member = (target, key) => {
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    };
    const handler = {
      get: (target, key) =>
        typeof key !== "string" || key in Storage.prototype
          ? member(target, key)
          : (target.getItem(key) ?? undefined),
      set: (target, key, value) => (target.setItem(key, value), true),
      has: (target, key) => target.getItem(key) !== null,
      deleteProperty: (target, key) => (target.removeItem(key), true),
      ownKeys: (target) => ns.storageKeys(target),
      getOwnPropertyDescriptor: (target, key) => {
        const value = target.getItem(key);
        return value === null
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
    };
    for (const name of ["localStorage", "sessionStorage"]) {
      const proxy = new Proxy(
        Object.getOwnPropertyDescriptor(window, name).get.call(window),
        handler,
      );
      Object.defineProperty(window, name, {
        get: () => proxy,
        configurable: true,
        enumerable: true,
      });
    }
  }

  /** `storage` events for other namespaces never reach the page. */
  function storageEventPart(ns) {
    if (typeof StorageEvent === "undefined") return;
    const rawKey = ns.getter(StorageEvent.prototype, "key");
    Object.defineProperty(StorageEvent.prototype, "key", {
      get: function key() {
        const value = rawKey.call(this);
        return value === null ? null : ns.unwrap(value);
      },
      configurable: true,
    });
    const foreign = (event) => {
      const key = rawKey.call(event);
      if (key !== null && ns.unwrap(key) === null) event.stopImmediatePropagation();
    };
    window.addEventListener("storage", foreign, true);
  }

  function indexedDbPart(ns) {
    if (typeof IDBFactory === "undefined") return;
    const proto = IDBFactory.prototype;
    const raw = {
      open: ns.original(proto, "open"),
      remove: ns.original(proto, "deleteDatabase"),
      list: ns.original(proto, "databases"),
    };
    proto.open = function open(name, ...rest) {
      return raw.open.call(this, ns.wrap(name), ...rest);
    };
    proto.deleteDatabase = function deleteDatabase(name) {
      return raw.remove.call(this, ns.wrap(name));
    };
    proto.databases = async function databases() {
      const all = (await raw.list.call(this)).map((info) => ({
        ...info,
        name: ns.unwrap(info.name),
      }));
      return all.filter(({ name }) => name !== null);
    };
    const rawName = ns.getter(IDBDatabase.prototype, "name");
    Object.defineProperty(IDBDatabase.prototype, "name", {
      get: function name() {
        return ns.unwrap(rawName.call(this));
      },
      configurable: true,
    });
  }

  function cachesPart(ns) {
    if (typeof CacheStorage === "undefined") return;
    const proto = CacheStorage.prototype;
    const raw = {
      open: ns.original(proto, "open"),
      has: ns.original(proto, "has"),
      remove: ns.original(proto, "delete"),
      keys: ns.original(proto, "keys"),
    };
    const own = async (storage) =>
      (await raw.keys.call(storage)).map(ns.unwrap).filter((name) => name !== null);
    proto.open = function open(name) {
      return raw.open.call(this, ns.wrap(name));
    };
    proto.has = function has(name) {
      return raw.has.call(this, ns.wrap(name));
    };
    proto.delete = function remove(name) {
      return raw.remove.call(this, ns.wrap(name));
    };
    proto.keys = function keys() {
      return own(this);
    };
    proto.match = async function match(request, options = {}) {
      const names = options.cacheName === undefined ? await own(this) : [options.cacheName];
      for (const name of names) {
        const found = await (await raw.open.call(this, ns.wrap(name))).match(request, options);
        if (found) return found;
      }
      return undefined;
    };
  }

  /** A container's root is its own directory; the control's root hides those directories. */
  function opfsPart(ns) {
    if (typeof StorageManager === "undefined" || !("getDirectory" in StorageManager.prototype))
      return;
    const raw = ns.original(StorageManager.prototype, "getDirectory");
    if (!ns.control) {
      StorageManager.prototype.getDirectory = async function getDirectory() {
        return (await raw.call(this)).getDirectoryHandle(`rnr-${ns.container}`, { create: true });
      };
      return;
    }
    const proto = FileSystemDirectoryHandle.prototype;
    const rawEntries = ns.original(proto, "entries");
    proto.entries = async function* entries() {
      for await (const entry of rawEntries.call(this))
        if (!entry[0].startsWith("rnr-")) yield entry;
    };
    proto.keys = async function* keys() {
      for await (const [name] of proto.entries.call(this)) yield name;
    };
    proto.values = async function* values() {
      for await (const [, handle] of proto.entries.call(this)) yield handle;
    };
    proto[Symbol.asyncIterator] = ns.original(proto, "entries");
  }

  function channelsPart(ns) {
    if (typeof BroadcastChannel !== "undefined" && !ns.control) {
      const Raw = BroadcastChannel;
      const rawName = ns.getter(Raw.prototype, "name");
      globalThis.BroadcastChannel = class BroadcastChannel extends Raw {
        constructor(name) {
          super(ns.wrap(name));
        }
        get name() {
          return ns.unwrap(rawName.call(this));
        }
      };
    }
    if (typeof LockManager === "undefined") return;
    const proto = LockManager.prototype;
    const raw = { request: ns.original(proto, "request"), query: ns.original(proto, "query") };
    const own = (locks) =>
      locks
        .map((lock) => ({ ...lock, name: ns.unwrap(lock.name) }))
        .filter(({ name }) => name !== null);
    proto.request = function request(name, ...rest) {
      return raw.request.call(this, ns.wrap(name), ...rest);
    };
    proto.query = async function query() {
      const { held, pending } = await raw.query.call(this);
      return { held: own(held), pending: own(pending) };
    };
  }

  /** Installs the parts once per realm; for a container, later runs refresh the cookie snapshot. */
  function install(config, parts) {
    if (globalThis[config.marker]) return globalThis[config.marker](config.cookies);
    const prefix = `rnr:${config.container}:`;
    const binding = globalThis[config.binding];
    const ns = {
      ...config,
      cookies: config.cookies ?? [],
      wrap: (name) => (config.control ? String(name) : prefix + String(name)),
      unwrap: (name) =>
        config.control
          ? name.startsWith("rnr:")
            ? null
            : name
          : name.startsWith(prefix)
            ? name.slice(prefix.length)
            : null,
      report: (message) => binding?.(JSON.stringify(message)),
      // The originals the parts wrap, read before they replace them.
      original: (proto, name) => Reflect.get(proto, name),
      getter: (proto, name) =>
        Reflect.get(Reflect.getOwnPropertyDescriptor(proto, name) ?? {}, "get"),
    };
    for (const part of parts) part(ns);
    Object.defineProperty(globalThis, config.marker, {
      value: (cookies) => (ns.cookies = cookies),
      enumerable: false,
    });
  }

  const parts = [
    storagePart,
    storageAccessPart,
    storageEventPart,
    indexedDbPart,
    cachesPart,
    opfsPart,
    channelsPart,
  ];
  globalThis.rnrPrelude = { install, parts };
})();
