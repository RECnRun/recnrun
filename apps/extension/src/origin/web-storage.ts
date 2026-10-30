/** Every key and value of `storage`; `Object.fromEntries` keeps keys like `__proto__` as data. */
export function readEntries(storage: Storage): Record<string, string> {
  const pairs: [string, string][] = [];
  for (let at = 0; at < storage.length; at += 1) {
    const key = storage.key(at);
    // A key read a moment ago is gone only if the page removed it meanwhile.
    const value = key === null ? null : storage.getItem(key);
    if (key !== null && value !== null) pairs.push([key, value]);
  }
  return Object.fromEntries(pairs);
}

/** Writes every entry into `storage` and counts them. */
export function writeEntries(storage: Storage, entries: Record<string, string>): number {
  const pairs = Object.entries(entries);
  for (const [key, value] of pairs) storage.setItem(key, value);
  return pairs.length;
}
