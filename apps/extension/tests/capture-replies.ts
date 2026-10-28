// The replies an origin agent sends during one capture of `app.localhost`, in order.
const ORIGIN = "http://app.localhost:5192";
const KV = { name: "kv", keyPath: null, autoIncrement: false, indexes: [], records: [] };
export const DATABASE = { name: "app", version: 3, stores: [KV] };
export const RECORDS = [
  { key: 1, value: { at: new Date(0), tags: new Set(["a"]) } },
  { key: 2, value: "plain" },
];

export const LOCAL = { theme: "dark", "": "", "ключ 🔑": "värde" };
export const SESSION = { tab: "" };
export const STORAGE = { type: "capture-storage", localStorage: LOCAL, sessionStorage: SESSION };
export const SCHEMA = { type: "capture-database", database: DATABASE };
export const PART = { type: "capture-records", database: "app", store: "kv", records: RECORDS };
const ENTRY = {
  request: { url: `${ORIGIN}/a`, method: "GET", headers: [] },
  response: { status: 200, statusText: "OK", headers: [], body: new ArrayBuffer(2) },
};
export const OPAQUE = { item: "v1 GET http://cdn.localhost/lib.js", reason: "Opaque." };
export const CACHE = {
  type: "capture-cache",
  cache: { name: "v1", entries: [ENTRY] },
  unsupported: [OPAQUE],
};
export const COUNTS = {
  databases: 1,
  records: 2,
  localStorage: 3,
  sessionStorage: 1,
  caches: 1,
  cacheEntries: 1,
};
export const capturedWith = (counts: Partial<typeof COUNTS>) => ({
  type: "captured",
  counts: { ...COUNTS, ...counts },
});
export const completeReplies = [STORAGE, SCHEMA, PART, CACHE, capturedWith({})];
