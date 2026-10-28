import { afterEach, expect, test, vi } from "vite-plus/test";
import type { OriginData } from "@recnrun/domain";
import { captureOrigin } from "@/origin/capture";
import { restoreOrigin } from "@/origin/restore";
import { entriesOf, memoryStorage } from "./origin-storage";

type WebStorage = Pick<OriginData, "localStorage" | "sessionStorage">;

const emptyStores = () => ({
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  indexedDB,
});

/** Captures `stores` and returns the Web Storage message the agent would send, and the counts. */
async function captured(stores: ReturnType<typeof emptyStores>) {
  const sent: WebStorage[] = [];
  const sink = {
    storage: (entries: WebStorage) => sent.push(entries),
    database: vi.fn(),
    records: vi.fn(),
  };
  const counts = await captureOrigin(stores, sink, 500);
  expect(sent).toHaveLength(1);
  return { counts, storage: sent[0] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Keys a page may use that a careless copy loses or mangles, with empty and unusual values. */
const ODD_ENTRIES: [string, string][] = [
  ["__proto__", "a"],
  ["constructor", ""],
  ["prototype", "c"],
  ["", "empty key"],
  ["ключ 🔑", "värde 😀"],
  ["lone", "\uD800 and \uDFFF"],
  ["big", "x".repeat(1_000_000)],
];

test("captures every Web Storage entry as the page's own Storage holds it, odd keys included", async () => {
  // The Vitest page's own sessionStorage proves the browser's Storage keeps these as written.
  for (const [key, value] of ODD_ENTRIES) sessionStorage.setItem(key, value);
  try {
    const stores = { ...emptyStores(), sessionStorage };
    stores.localStorage.setItem("theme", "dark");
    const { counts, storage } = await captured(stores);
    const ours = Object.entries(storage?.sessionStorage ?? {}).filter(([key]) =>
      ODD_ENTRIES.some(([odd]) => odd === key),
    );
    expect(new Map(ours)).toEqual(new Map(ODD_ENTRIES));
    expect(Object.entries(storage?.localStorage ?? {})).toEqual([["theme", "dark"]]);
    expect(counts.sessionStorage).toBe(sessionStorage.length);
  } finally {
    for (const [key] of ODD_ENTRIES) sessionStorage.removeItem(key);
  }
});

test("captured Web Storage restores into empty storage entry for entry", async () => {
  const source = emptyStores();
  for (const [key, value] of ODD_ENTRIES) source.localStorage.setItem(key, value);
  source.sessionStorage.setItem("tab", "");
  const { storage } = await captured(source);
  const target = emptyStores();
  const site = { localStorage: {}, sessionStorage: {}, ...storage, indexedDB: [] };
  await expect(restoreOrigin(target, site)).resolves.toMatchObject({
    localStorage: ODD_ENTRIES.length,
    sessionStorage: 1,
  });
  expect(Object.entries(entriesOf(target.localStorage))).toEqual(ODD_ENTRIES);
  expect(entriesOf(target.sessionStorage)).toEqual({ tab: "" });
});

test("an entry the page removes while it is read is left out, and counted as left out", async () => {
  const stores = emptyStores();
  const real = memoryStorage();
  const page = stores.localStorage;
  for (const key of ["kept", "removed", "shifted"])
    [page, real].forEach((s) => s.setItem(key, key));
  vi.spyOn(page, "getItem").mockImplementation((key) =>
    key === "removed" ? null : real.getItem(key),
  );
  vi.spyOn(page, "key").mockImplementation((at) => (at === 2 ? null : real.key(at)));
  const { counts, storage } = await captured(stores);
  expect(storage?.localStorage).toEqual({ kept: "kept" });
  expect(counts.localStorage).toBe(1);
});

test("a Storage that refuses to be read fails the capture at its step, before any database", async () => {
  const stores = emptyStores();
  vi.spyOn(stores.sessionStorage, "key").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  stores.sessionStorage.setItem("a", "b");
  const sink = { storage: vi.fn(), database: vi.fn(), records: vi.fn() };
  await expect(captureOrigin(stores, sink, 500)).rejects.toMatchObject({
    message: "sessionStorage: SecurityError",
  });
  expect(sink.storage).not.toHaveBeenCalled();
});
