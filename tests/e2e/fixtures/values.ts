import type { Page } from "@playwright/test";

/**
 * Writes one record of each structured-clone type the transport must keep into `values.kv`, plus
 * a record of `bigBytes` random bytes.
 */
export const writeValues = (page: Page, bigBytes: number) =>
  page.evaluate(async (size) => {
    const big = new Uint8Array(size);
    // getRandomValues fills at most 64 KiB per call.
    for (let at = 0; at < size; at += 65_536) {
      crypto.getRandomValues(big.subarray(at, Math.min(at + 65_536, size)));
    }
    const records: [string, unknown][] = [
      ["date", new Date(1_234_567)],
      ["blob", new Blob(["hello, blob"], { type: "text/x-recnrun" })],
      ["buffer", new Uint8Array([0, 1, 254, 255]).buffer],
      [
        "typed",
        {
          u8: new Uint8Array([1, 2, 3]),
          i16: new Int16Array([-2, 2]),
          f64: new Float64Array([1.5, -0, Number.NaN]),
          view: new DataView(new Uint8Array([9, 8]).buffer),
        },
      ],
      [
        "map",
        new Map<unknown, unknown>([
          ["a", 1],
          [2, { at: new Date(0) }],
        ]),
      ],
      ["set", new Set<unknown>(["x", 1, new Date(2)])],
      ["nested", { one: { two: { list: [1, { at: new Date(5) }], blob: new Blob(["n"]) } } }],
      ["nulls", { a: null, b: undefined, list: [null, undefined] }],
      ["undefined", undefined],
      ["big", { bytes: big }],
    ];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("values", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const transaction = db.transaction("kv", "readwrite");
    for (const [key, value] of records) transaction.objectStore("kv").put(value, key);
    await new Promise((resolve) => (transaction.oncomplete = resolve));
    db.close();
  }, bigBytes);

/** Each record of `values.kv` by key, described by type and content; large bytes by digest. */
export const describeValues = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(async () => {
    const bytesOf = async (bytes: Uint8Array) => {
      if (bytes.length <= 32) return [...bytes];
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
      return { length: bytes.length, sha256: [...digest].map((b) => b.toString(16)).join("") };
    };
    const leaf = (value: unknown) => {
      if (value === null || value === undefined) return { type: String(value) };
      if (value instanceof Date) return { type: "Date", time: value.getTime() };
      if (typeof value === "object") return undefined;
      const text = Object.is(value, -0) ? "-0" : String(value as string | number | boolean);
      return { type: typeof value, value: text };
    };
    const binary = async (value: object) => {
      if (value instanceof Blob) {
        return { type: "Blob", mime: value.type, size: value.size, text: await value.text() };
      }
      if (value instanceof ArrayBuffer) {
        return { type: "ArrayBuffer", bytes: await bytesOf(new Uint8Array(value)) };
      }
      if (!ArrayBuffer.isView(value)) return undefined;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { type: value.constructor.name, bytes: await bytesOf(bytes) };
    };
    const describe = async (value: unknown): Promise<unknown> => {
      const known = leaf(value) ?? (await binary(value as object));
      if (known) return known;
      const all = (items: unknown[]) => Promise.all(items.map(describe));
      if (value instanceof Map) {
        return { type: "Map", entries: await Promise.all([...value].map(all)) };
      }
      if (value instanceof Set) return { type: "Set", items: await all([...value]) };
      // Own keys, so a property holding `undefined` still shows up.
      const entries = Object.entries(value as object).map(async ([key, inner]) => [
        key,
        await describe(inner),
      ]);
      return {
        type: Array.isArray(value) ? "Array" : "Object",
        entries: await Promise.all(entries),
      };
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("values");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
    });
    const store = db.transaction("kv").objectStore("kv");
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve) => (request.onsuccess = () => resolve(request.result)));
    const [keys, values] = await Promise.all([read(store.getAllKeys()), read(store.getAll())]);
    db.close();
    const described: Record<string, unknown> = {};
    for (const [at, key] of keys.entries()) described[key as string] = await describe(values[at]);
    return described;
  });
