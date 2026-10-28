import { BLANK, closeWorkspace, openBlank } from "./fixtures/captures.ts";
import { LARGE_BYTES, cacheView, capturedReport, fillCaches } from "./fixtures/cache-storage.ts";
import type { CacheView } from "./fixtures/cache-storage.ts";
import { expect, test } from "./fixtures/extension.ts";
import { captureIdentity, startFromCapture } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { APP, pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const OTHER = "http://other.localhost:5192";

/** The entries no `Response` can rebuild: Chrome reports their status as 0. */
const OPAQUE_KEYS = [`${OTHER}/cache/basic`, `${APP}/cache/redirect?manual=1`];

/** A rebuilt entry, as Chromium's sources predict (cited in the POC checklist's S3.7 entry). */
const rebuilt = (entry: CacheView): CacheView => ({
  ...entry,
  type: "default",
  url: "",
  redirected: false,
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
    entries.filter(({ key }) => !OPAQUE_KEYS.includes(key)).map(rebuilt);
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
  expect(after.view).toEqual({
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
