// The hook's Web Storage capture, spliced in after DOM_CAPTURE: it uses `config`, `ensure`, `send`,
// and `safely` from there. It wraps the prototype methods, so property assignment
// (`localStorage.key = value`) and `delete` escape it; DOMStorage events still see those changes.
// Arguments that are objects are not stringified again, so a page's `toString` runs only once.
export const STORAGE_CAPTURE = `
  const apply = Reflect.apply;
  // Window is a [Global] interface, so Chrome defines its attributes on the window itself.
  const storageGetter = (name) => {
    for (let object = window; object; object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor) return descriptor.get;
    }
    return undefined;
  };
  const AREAS = [["local", storageGetter("localStorage")], ["session", storageGetter("sessionStorage")]];
  const areaOf = (storage) => {
    for (const [area, get] of AREAS) {
      try {
        if (get && apply(get, window, []) === storage) return area;
      } catch {}
    }
    return undefined;
  };
  const textOf = (value, flags) => {
    if (value !== null && (typeof value === "object" || typeof value === "function" || typeof value === "symbol")) return undefined;
    const text = String(value);
    if (text.length > config.maxText) flags.truncated = true;
    return text.slice(0, config.maxText);
  };
  // Only built-in errors are asked their name, so a page's own getter never runs.
  const nameOf = (error) =>
    error instanceof Error || (typeof DOMException === "function" && error instanceof DOMException) ? error.name : "Error";
  const report = (storage, operation, args, error) => {
    const area = areaOf(storage);
    if (!area) return;
    ensure();
    const flags = {};
    const payload = { area, operation };
    if (operation !== "clear") payload.key = textOf(args[0], flags);
    if (operation === "setItem") payload.value = textOf(args[1], flags);
    if (error !== undefined) payload.error = textOf(nameOf(error), flags);
    send("storage", "storage.operation", { ...payload, ...flags });
  };
  const wrapStorage = (operation) => {
    const original = Storage.prototype[operation];
    if (typeof original !== "function") return;
    const wrapped = {
      [operation](...args) {
        let error;
        try {
          return apply(original, this, args);
        } catch (thrown) {
          error = thrown;
          throw thrown;
        } finally {
          safely(() => report(this, operation, args, error));
        }
      },
    }[operation];
    Object.defineProperty(Storage.prototype, operation, { value: wrapped, writable: true, enumerable: true, configurable: true });
  };
  if (typeof Storage === "function")
    for (const operation of config.storageOperations) safely(() => wrapStorage(operation));
`;
