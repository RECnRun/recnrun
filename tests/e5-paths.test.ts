import { describe, expect, test } from "vite-plus/test";
import {
  evaluateAddress,
  evaluateOffline,
  evaluateTabSession,
  evaluateUpdate,
} from "./experiments/e5-paths.ts";
import type { OfflineSample, UpdateSample } from "./experiments/e5-paths.ts";
import type { PausedEntry, RouteBJournal } from "./experiments/e5-samples.ts";

const APP = "http://app.localhost:4600";
const SCRIPT = "/sw-main.js?variant=classic";
const FROM = `/me?from=${encodeURIComponent(SCRIPT)}`;
const ME = `http://api.localhost:4601${FROM}`;

function journal(paused: PausedEntry[] = []): RouteBJournal {
  return { tabs: [], workers: [], paused };
}

const fulfilled: PausedEntry = {
  session: "worker",
  url: `${APP}${SCRIPT}`,
  resourceType: "Other",
  stage: "response",
  role: "main",
  action: "fulfilled",
  declared: "transformed",
  waitedMs: 2,
};

function update(overrides: Partial<UpdateSample> = {}): UpdateSample {
  return {
    variant: "same-marker",
    marker: "e5-m1",
    script: SCRIPT,
    outcome: { updatefound: false, installing: false, waiting: false },
    journal: journal(),
    effects: [],
    ...overrides,
  };
}

describe("E5 update", () => {
  test("passes an unchanged script that installs nothing", () => {
    expect(evaluateUpdate(update())).toEqual({
      variant: "same-marker",
      reasons: [],
      tally: { installed: 0 },
      waited: [],
    });
  });

  test("says when an unchanged script installed a version Chrome fetched unwrapped", () => {
    const outcome = evaluateUpdate(
      update({ outcome: { updatefound: true, installing: true }, effects: [FROM] }),
    );
    expect(outcome.reasons).toEqual([
      {
        kind: "newVersionInstalled",
        text: "update() installed a new version for unchanged app bytes",
      },
      {
        kind: "notIntercepted",
        text: `no Fetch.requestPaused for ${SCRIPT} on the tab or worker session`,
      },
      { kind: "unmarkedEffect", text: `the new version's request without the marker: ${FROM}` },
    ]);
    expect(outcome.tally).toEqual({ installed: 1 });
  });

  test("passes a changed wrapper whose new version Route B fulfilled and marked", () => {
    const changed = update({
      variant: "new-marker",
      outcome: { updatefound: true, installing: true },
      journal: journal([fulfilled]),
      effects: [`${FROM}&__rec=e5-m1`],
    });
    expect(evaluateUpdate(changed)).toEqual({
      variant: "new-marker",
      reasons: [],
      tally: { installed: 1, updateCheckPaused: 1, transformed: 1 },
      waited: [2],
    });
    const stale = evaluateUpdate(update({ variant: "new-marker", outcome: { error: "Boom" } }));
    expect(stale.reasons.map((reason) => reason.text)).toEqual([
      "update() failed: Boom",
      "update() installed no new version for a changed wrapper",
    ]);
  });
});

function offline(overrides: Partial<OfflineSample> = {}): OfflineSample {
  return {
    marker: "e5-m1",
    script: SCRIPT,
    store: "fixture-sw",
    workersGone: true,
    firstTransformed: true,
    shown: "Fixture offline",
    effects: [`${FROM}&__rec=e5-m1`],
    databases: ["__rec:e5-m1:fixture-sw"],
    caches: ["__rec:e5-m1:fixture-sw", "__rec:e5-m1:fixture-shell-v1"],
    network: [],
    ...overrides,
  };
}

describe("E5 offline", () => {
  test("passes a restart served from the cache whose first request carries the stored marker", () => {
    expect(evaluateOffline(offline())).toEqual({
      variant: "classic",
      reasons: [],
      tally: { servedOffline: 1, markedInNetwork: 0 },
      waited: [],
    });
  });

  test("says what Chrome blocked when no request reached the fixture", () => {
    const blocked = {
      requestId: "1",
      url: `${ME}&__rec=e5-m1`,
      errorText: "net::ERR_FAILED",
      corsError: "LocalNetworkAccessPermissionDenied",
    };
    const outcome = evaluateOffline(offline({ effects: [], network: [blocked] }));
    expect(outcome.reasons).toEqual([
      {
        kind: "noEffect",
        text: `no request from the restarted worker reached the fixture; Chrome blocked ${FROM} (net::ERR_FAILED, LocalNetworkAccessPermissionDenied)`,
      },
    ]);
    expect(outcome.tally).toEqual({ servedOffline: 1, markedInNetwork: 1 });
  });

  test("says when the worker never stopped, ran unwrapped, or the page was not served offline", () => {
    const outcome = evaluateOffline(
      offline({
        workersGone: false,
        firstTransformed: false,
        shown: "net::ERR_FAILED",
        databases: ["fixture-sw"],
      }),
    );
    expect(outcome.reasons.map((reason) => reason.kind)).toEqual([
      "notStopped",
      "notTransformed",
      "notServedOffline",
      "storeUnprefixed:IndexedDB",
    ]);
    expect(outcome.reasons[2]?.text).toBe("the offline navigation showed net::ERR_FAILED");
  });
});

describe("E5 diagnostics", () => {
  test("names every address space other than loopback and every request Chrome blocked", () => {
    const control = [{ requestId: "1", url: ME, initiatorIPAddressSpace: "Loopback" }];
    expect(evaluateAddress({ variant: "control", network: control })).toEqual({
      variant: "control",
      reasons: [],
      tally: { "space:Loopback": 1 },
      waited: [],
    });
    const network = [
      { requestId: "2", url: `${APP}/index.html`, initiatorIPAddressSpace: "Unknown" },
      { requestId: "3", url: `${ME}&__rec=m`, errorText: "net::ERR_FAILED", corsError: "X" },
      { requestId: "4", errorText: "net::ERR_FAILED", corsError: "X" },
    ];
    expect(evaluateAddress({ variant: "fulfilled", network })).toEqual({
      variant: "fulfilled",
      reasons: [
        { kind: "addressSpace", text: "the worker's requests left from address space Unknown" },
        { kind: "blocked", text: `Chrome blocked ${FROM} (net::ERR_FAILED, X)` },
        { kind: "blocked", text: "Chrome blocked a request without a URL (net::ERR_FAILED, X)" },
      ],
      tally: { "space:Unknown": 1, blockedRequests: 2 },
      waited: [],
    });
  });

  test("says where the main script paused when the tab session never saw it", () => {
    const page = {
      ...fulfilled,
      session: "tab" as const,
      url: `${APP}/page.js`,
      resourceType: "Script",
    };
    const outcome = evaluateTabSession({
      variant: "*",
      script: SCRIPT,
      journal: journal([page, fulfilled]),
    });
    expect(outcome).toEqual({
      variant: "*",
      reasons: [
        {
          kind: "notOnTabSession",
          text: `${SCRIPT} never paused on the tab session; Chrome paused it on the worker session as Other`,
        },
      ],
      tally: { "tab:Script": 1, "worker:Other": 1 },
      waited: [],
    });
    const nowhere = evaluateTabSession({ variant: "*", script: SCRIPT, journal: journal() });
    expect(nowhere.reasons[0]?.text).toBe(`${SCRIPT} never paused on the tab session or any other`);
    const onTab = evaluateTabSession({
      variant: "*",
      script: SCRIPT,
      journal: journal([{ ...fulfilled, session: "tab" }]),
    });
    expect(onTab.reasons).toEqual([]);
  });
});
