import { BLANK, closeWorkspace, openBlank } from "./fixtures/captures.ts";
import { LARGE_BYTES, cacheView, capturedReport, fillCaches } from "./fixtures/cache-storage.ts";
import type { CacheView } from "./fixtures/cache-storage.ts";
import { expect, test } from "./fixtures/extension.ts";
import { captureIdentity, journalOf, startFromCapture } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const OTHER = "http://other.localhost:5192";

/** The entries no `Response` can rebuild: Chrome reports their status as 0. */
const OPAQUE_KEYS = [`${OTHER}/cache/basic`, `${APP}/cache/redirect?manual=1`];

/** An entry as it comes back: a fetched one fetched again, so the server dates it anew. */
const undated = (entry: CacheView): CacheView => ({
  ...entry,
  headers: entry.headers.filter(([name]) => name !== "date"),
});

test("the managed tab's caches come back entry for entry, opaque ones named as unsupported", async ({
  context,
  serviceWorker,
}) => {
  const source = await openBlank(context, serviceWorker);
  await fillCaches(source);
  const before = await cacheView(source);
  const summary = await captureIdentity(serviceWorker, "identity-a");
  const report = await capturedReport(serviceWorker, "identity-a");
  await closeWorkspace(serviceWorker, source);

  const timings = await startFromCapture(serviceWorker, "identity-a");
  const restored = await pageAt(context, BLANK);
  const after = await cacheView(restored);
  await closeWorkspace(serviceWorker, restored);

  const kept = (entries: CacheView[] = []) =>
    entries.filter(({ key }) => !OPAQUE_KEYS.includes(key)).map(undated);
  expect(Object.keys(before.view)).toEqual(["pages-v1", "api-v1"]);
  expect(before.view["api-v1"]?.filter(({ status }) => status === 0).map(({ key }) => key)).toEqual(
    OPAQUE_KEYS,
  );
  expect(summary).toMatchObject({ caches: 2, cacheEntries: 7, unsupported: 2 });
  expect(report.adapters?.every(({ status }) => status === "captured")).toBe(true);
  expect(report.unsupported?.map(({ adapter, item }) => `${adapter} ${item}`)).toEqual([
    `cacheStorage api-v1 GET ${OTHER}/cache/basic`,
    `cacheStorage api-v1 GET ${APP}/cache/redirect`,
  ]);
  // A fetched entry keeps its type, URL, and redirect; a constructed one had none to keep.
  expect(before.view["pages-v1"]?.find(({ key }) => key.endsWith("/cache/redirect"))).toMatchObject(
    { type: "basic", url: `${APP}/cache/basic?via=redirect`, redirected: true },
  );
  expect({
    "pages-v1": after.view["pages-v1"]?.map(undated),
    "api-v1": after.view["api-v1"]?.map(undated),
  }).toEqual({
    "pages-v1": kept(before.view["pages-v1"]),
    "api-v1": kept(before.view["api-v1"]),
  });
  expect(before.varyMatches).toEqual({ a: true, b: false });
  expect(after.varyMatches).toEqual(before.varyMatches);

  await keep("capture-cache-storage", {
    summary,
    restoreTimings: timings,
    unsupported: report.unsupported,
    largeBytes: LARGE_BYTES,
    // Fields only: bodies leave the page as their size and digest.
    before: before.view,
    after: after.view,
  });
});

test("an entry the server now answers differently comes back as captured, without its URL, and is named", async ({
  context,
  serviceWorker,
}) => {
  const source = await openBlank(context, serviceWorker);
  // Each answer differs, as a page that changed since the capture.
  await source.evaluate(async () => (await caches.open("pages-v1")).add("/cache/changing"));
  const before = await cacheView(source);
  await captureIdentity(serviceWorker, "identity-a");
  await closeWorkspace(serviceWorker, source);

  await startFromCapture(serviceWorker, "identity-a");
  const restored = await pageAt(context, BLANK);
  const after = await cacheView(restored);
  await closeWorkspace(serviceWorker, restored);

  const [captured] = before.view["pages-v1"] ?? [];
  expect(captured).toMatchObject({ type: "basic", url: `${APP}/cache/changing` });
  expect(after.view["pages-v1"]).toEqual([
    { ...captured, type: "default", url: "", redirected: false },
  ]);
  expect((await journalOf(serviceWorker))?.rebuilt).toEqual([
    {
      origin: APP,
      item: `pages-v1 GET ${APP}/cache/changing`,
      reason: "The server now sends another body, so it comes back as captured, without its URL.",
    },
  ]);
});
