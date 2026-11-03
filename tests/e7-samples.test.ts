import { describe, expect, test } from "vite-plus/test";
import {
  APP,
  BLOB_FROM,
  ME,
  START,
  THROWN,
  WORKER,
  WORKER_ME,
  page,
  worker,
} from "./e7-builders.ts";
import { attributeWorkers, evaluateSample, realmPaths } from "./experiments/e7-samples.ts";

const API = "http://api.localhost:4601";
const IDP = "http://idp.localhost:4602";

describe("E7 sample evaluation", () => {
  test("passes a page whose start, later fetches, and stores carry its marker", () => {
    expect(evaluateSample(page())).toEqual({
      passed: true,
      kinds: [],
      reasons: [],
      notes: ["beforeFirstScript", "unprefixedLocalStorage"],
    });
  });

  test("a start without the marker is an effect before the marker; a later one is unmarked", () => {
    const late = evaluateSample(page({ start: START }));
    expect([late.passed, late.kinds, late.reasons]).toEqual([
      false,
      ["firstEffectBeforeMarker"],
      [`first effect without the marker: ${START}`],
    ]);
    expect(late.notes).not.toContain("beforeFirstScript");
    const later = evaluateSample(page({ effects: [ME] }));
    expect([later.kinds, later.reasons]).toEqual([
      ["unmarkedEffect"],
      [`effect without the marker: ${ME}`],
    ]);
  });

  test("tells an unpatched realm and a stale slot apart from a late bootstrap", () => {
    const unpatched = evaluateSample(page({ start: START, effects: [ME] }));
    expect(unpatched.kinds).toEqual(["unpatched", "firstEffectBeforeMarker", "unmarkedEffect"]);
    const stale = evaluateSample(page({ start: `${START}&__rec=slot-2` }));
    expect([stale.kinds, stale.reasons]).toEqual([
      ["staleMarker"],
      [`effect carries slot-2, not slot-3: ${START}`],
    ]);
  });

  test("a missing start, or no request at all, is no effect", () => {
    expect(evaluateSample(page({ start: null })).kinds).toEqual(["noEffect"]);
    expect(evaluateSample(page({ start: null, effects: [] })).reasons).toEqual([
      "no start marker in the ledger",
      "no request from the realm in the ledger",
    ]);
  });

  test("counts stores opened without the prefix, missing, or unreadable", () => {
    const leaked = page({
      inventory: { indexedDB: ["fixture-page"], cacheStorage: [] },
    });
    expect(evaluateSample(leaked).reasons).toEqual([
      "IndexedDB holds fixture-page without the prefix",
      "Cache Storage has no fixture-page under the load's marker",
    ]);
    expect(evaluateSample(leaked).kinds).toEqual(["unprefixedIndexedDB", "storeMissing"]);
    const unreadable = page({ inventory: { indexedDB: { error: "gone" }, cacheStorage: [] } });
    expect(evaluateSample(unreadable).kinds).toEqual(["storeUnreadable", "storeMissing"]);
    expect(evaluateSample(page({ inventory: undefined })).passed).toBe(true);
  });

  test("records a refused worker as failed closed with the thrown error, not as unpatched", () => {
    const refused = worker(
      {
        variant: "fail-closed/classic",
        effects: [],
        inventory: { indexedDB: [], cacheStorage: [] },
      },
      THROWN,
    );
    expect(evaluateSample(refused)).toEqual({
      passed: false,
      kinds: ["failClosed"],
      reasons: [`failed closed: ${THROWN}`],
      notes: [],
    });
    const ranAnyway = evaluateSample({
      ...refused,
      effects: [WORKER_ME],
      inventory: { indexedDB: ["fixture-dedicated"], cacheStorage: [] },
    });
    expect(ranAnyway.kinds).toEqual(["failClosed", "unpatched", "unprefixedIndexedDB"]);
  });

  test("a wrapped worker that runs under its wrapper's URL changed its location", () => {
    const blob = worker({
      effects: [`/me?from=${encodeURIComponent(BLOB_FROM)}&__rec=slot-1`],
      worker: { script: WORKER, from: BLOB_FROM, report: { user: "alice" } },
    });
    expect(evaluateSample(blob)).toMatchObject({
      passed: false,
      kinds: ["locationChanged"],
      reasons: [`self.location is a blob: URL, not ${WORKER}`],
    });
    const data = worker({
      worker: { script: WORKER, from: "text/javascript;charset=utf-8,import...", report: {} },
    });
    expect(evaluateSample(data).reasons).toEqual([`self.location is a data: URL, not ${WORKER}`]);
  });

  test("a worker the page got no report from, or whose first statements failed, says so", () => {
    expect(
      evaluateSample(worker({ effects: [] }, "error: Error: worker failed to start")),
    ).toMatchObject({
      kinds: ["noReport", "noEffect"],
      reasons: [
        "the page got no report: error: Error: worker failed to start",
        "no request from the realm in the ledger",
      ],
    });
    const failed = evaluateSample(
      worker({}, { realm: "dedicated", error: "TypeError: Failed to fetch" }),
    );
    expect([failed.kinds, failed.reasons]).toEqual([
      ["workerError"],
      ["first statements failed: TypeError: Failed to fetch"],
    ]);
  });

  test("a frame Route C is not registered for passes only while nothing in it is marked", () => {
    const frame = page({
      hypothesis: "cross-site-iframe",
      variant: "app-only",
      expect: "unmarked",
      start: "/__marker?name=idp-renew%3Astart",
      effects: ["/renew"],
      store: undefined,
      inventory: undefined,
    });
    expect(evaluateSample(frame)).toEqual({ passed: true, kinds: [], reasons: [], notes: [] });
    const reached = evaluateSample({ ...frame, effects: ["/renew?__rec=slot-3"] });
    expect([reached.kinds, reached.reasons]).toEqual([
      ["injectedUnregistered"],
      ["marked where Route C is not registered: /renew"],
    ]);
  });

  test("a popup or frame whose opener got no message fails on that alone, naming the message", () => {
    const popup = page({ hypothesis: "popup", store: undefined, openerMessage: false });
    expect([evaluateSample(popup).kinds, evaluateSample(popup).reasons]).toEqual([
      ["openerMessageMissing"],
      ["the opener got no fixture-login message"],
    ]);
    const frame = { ...popup, hypothesis: "cross-site-iframe" };
    expect(evaluateSample(frame).reasons).toEqual(["the parent got no fixture-renew message"]);
  });
});

describe("E7 ledger attribution", () => {
  const entries = [
    { seq: 1, origin: APP, path: "/storage.js", secFetchDest: "script", marker: null },
    {
      seq: 2,
      origin: APP,
      path: `${START}&__rec=slot-3`,
      secFetchDest: "empty",
      marker: "storage:start",
    },
    { seq: 3, origin: API, path: "/me?__rec=slot-3", secFetchDest: "empty", marker: null },
    { seq: 4, origin: IDP, path: "/renew", secFetchDest: "empty", marker: null },
    { seq: 5, origin: APP, path: "/favicon.ico", secFetchDest: "image", marker: null },
  ];

  test("a realm's start is its start marker; its effects are its later fetches on its origins", () => {
    expect(realmPaths(entries, "storage:start", [APP, API])).toEqual({
      start: `${START}&__rec=slot-3`,
      effects: ["/me?__rec=slot-3"],
    });
    expect(realmPaths(entries, "idp-renew:start", [IDP])).toEqual({ start: null, effects: [] });
  });

  test("gives each worker its own request, and wrapper URLs in construction order", () => {
    const shared = "/shared-worker.js?type=classic";
    const scripts = { dedicated: WORKER, shared };
    const blob = (id: string) => `/me?from=${encodeURIComponent(`${APP}/${id}`)}&__rec=slot-1`;
    expect(attributeWorkers([blob("a"), blob("b"), "/me"], scripts, {})).toEqual({
      dedicated: blob("a"),
      shared: blob("b"),
    });
    const sharedMe = `/me?from=${encodeURIComponent(shared)}`;
    expect(attributeWorkers([sharedMe, blob("a")], scripts, {})).toEqual({
      dedicated: blob("a"),
      shared: sharedMe,
    });
    expect(attributeWorkers([blob("b")], scripts, { dedicated: THROWN })).toEqual({
      shared: blob("b"),
    });
  });

  test("a data: wrapper's location names its script, whatever the order or the report", () => {
    const scripts = { dedicated: WORKER, shared: "/shared-worker.js?type=classic" };
    const data = (script: string) => {
      const source = encodeURIComponent(`importScripts("${APP}${script}");\n`);
      return `/me?from=${encodeURIComponent(`text/javascript;charset=utf-8,${source}`)}`;
    };
    const both = [data(scripts.shared), data(scripts.dedicated)];
    expect(attributeWorkers(both, scripts, {})).toEqual({
      dedicated: data(scripts.dedicated),
      shared: data(scripts.shared),
    });
    const failed = { dedicated: "error: Error: worker failed to start" };
    expect(attributeWorkers([data(scripts.dedicated)], scripts, failed)).toEqual({
      dedicated: data(scripts.dedicated),
    });
  });
});
