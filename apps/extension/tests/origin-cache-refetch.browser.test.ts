import type { OriginData } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { OTHER_BODY, OTHER_RESPONSE, UNREACHABLE } from "@/origin/cache-refetch";
import { writeCaches } from "@/origin/cache-storage";
import { clearCaches } from "./origin-storage";

type Entry = OriginData["caches"][number]["entries"][number];

const pageFetch = globalThis.fetch.bind(globalThis);
/** A real fetch's answer, which has a URL; a data URL needs no server. */
const answer = (body: string) => pageFetch(`data:text/plain,${body}`);
const ANSWERED = "data:text/plain,a";

/** An entry as a capture keeps it; a fetched one names the URL it was fetched from. */
function entry(path: string, response: Partial<Entry["response"]> = {}): Entry {
  return {
    request: { url: `${location.origin}${path}`, method: "GET", headers: [["x-variant", "a"]] },
    response: {
      status: 200,
      statusText: "",
      headers: [["x-kept", "1"]],
      body: new TextEncoder().encode("a").buffer,
      type: "basic",
      url: ANSWERED,
      redirected: false,
      ...response,
    },
  };
}

async function readBack(path: string) {
  const response = await (await caches.open("v1")).match(path);
  return { url: response?.url, type: response?.type, body: await response?.text() };
}

beforeEach(clearCaches);

afterEach(async () => {
  vi.restoreAllMocks();
  await clearCaches();
});

test("a fetched entry is fetched again, without cookies, and goes back with its URL", async () => {
  const fetching = vi.spyOn(globalThis, "fetch").mockImplementation(() => answer("a"));
  const written = await writeCaches(caches, [{ name: "v1", entries: [entry("/a")] }]);
  expect(written).toEqual({ entries: 1, rebuilt: [] });
  expect(await readBack("/a")).toEqual({ url: ANSWERED, type: "basic", body: "a" });
  expect(fetching).toHaveBeenCalledExactlyOnceWith(
    `${location.origin}/a`,
    expect.objectContaining({
      method: "GET",
      headers: [["x-variant", "a"]],
      credentials: "omit",
      cache: "no-store",
    }),
  );
});

test("a constructed entry is never fetched and goes back as captured", async () => {
  const fetching = vi.spyOn(globalThis, "fetch");
  const made = entry("/made", { type: "default", url: "" });
  await expect(writeCaches(caches, [{ name: "v1", entries: [made] }])).resolves.toEqual({
    entries: 1,
    rebuilt: [],
  });
  expect(fetching).not.toHaveBeenCalled();
  expect(await readBack("/made")).toEqual({ url: "", type: "default", body: "a" });
});

test("an entry the server answers otherwise goes back as captured, named without its query", async () => {
  const failed = () => Promise.reject(new TypeError("Failed to fetch"));
  const answers = [() => answer("b"), () => answer("a"), failed];
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    (answers.shift() ?? (() => answer("a")))(),
  );
  const entries = [
    // Fetched from the same URL as captured, whose answer is now another body.
    entry("/body?token=s3cret", { url: "data:text/plain,b" }),
    entry("/status", { status: 201 }),
    entry("/gone"),
    entry("/moved", { redirected: true }),
  ];
  const written = await writeCaches(caches, [{ name: "v1", entries }]);
  const item = (path: string) => `v1 GET ${location.origin}${path}`;
  expect(written).toEqual({
    entries: 4,
    rebuilt: [
      { item: item("/body"), reason: OTHER_BODY },
      { item: item("/status"), reason: OTHER_RESPONSE },
      { item: item("/gone"), reason: UNREACHABLE },
      { item: item("/moved"), reason: OTHER_RESPONSE },
    ],
  });
  expect(JSON.stringify(written)).not.toMatch(/s3cret/);
  expect(await readBack("/body?token=s3cret")).toEqual({ url: "", type: "default", body: "a" });
  const kept = await (await caches.open("v1")).match("/status");
  expect([kept?.status, kept?.headers.get("x-kept")]).toEqual([201, "1"]);
});

test("entries go back in their captured order, fetched a few at a time", async () => {
  let open = 0;
  let most = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    open += 1;
    most = Math.max(most, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open -= 1;
    return answer("a");
  });
  const paths = Array.from({ length: 14 }, (_, at) => `/e${at}`);
  await writeCaches(caches, [{ name: "v1", entries: paths.map((path) => entry(path)) }]);
  const keys = await (await caches.open("v1")).keys();
  expect(keys.map(({ url }) => new URL(url).pathname)).toEqual(paths);
  expect(most).toBe(6);
});
