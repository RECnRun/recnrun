import { describe, expect, test } from "vite-plus/test";
import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { evaluateFirst, evaluateImports, verdictOf } from "./experiments/e5-samples.ts";
import type { FirstSample, PausedEntry, RouteBJournal } from "./experiments/e5-samples.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "cdp-load-unpacked" };
const APP = "http://app.localhost:4600";
const SCRIPT = "/sw-main.js?variant=classic";
const FROM = `/me?from=${encodeURIComponent(SCRIPT)}`;
const BLOCKED = "TypeError: Failed to fetch";

function paused(path: string, overrides: Partial<PausedEntry> = {}): PausedEntry {
  return {
    session: "worker",
    url: `${APP}${path}`,
    resourceType: "Other",
    stage: "response",
    role: "main",
    status: 200,
    action: "fulfilled",
    declared: "transformed",
    wrapper: "prepend",
    waitedMs: 3,
    ...overrides,
  };
}

function journal(entries: PausedEntry[], released = true): RouteBJournal {
  const worker = { targetId: "sw", type: "service_worker", url: `${APP}${SCRIPT}` };
  return {
    tabs: [{ tabId: 1, marker: "e5-m1", fetchEnable: "ok" }],
    workers: [{ ...worker, waitingForDebugger: true, fetchEnable: "ok", released }],
    paused: entries,
  };
}

function first(overrides: Partial<FirstSample> = {}): FirstSample {
  const marker = "e5-m1";
  return {
    variant: "classic",
    marker,
    script: SCRIPT,
    store: "fixture-sw",
    effects: [`${FROM}&__rec=${marker}`],
    databases: [`__rec:${marker}:fixture-sw`],
    caches: [`__rec:${marker}:fixture-sw`, `__rec:${marker}:fixture-shell-v1`],
    journal: journal([paused(SCRIPT)]),
    ...overrides,
  };
}

const kindsOf = (sample: FirstSample) => evaluateFirst(sample).reasons.map((r) => r.kind);

describe("E5 first registrations", () => {
  test("passes a main script fulfilled wrapped, a released worker, and marked effects and stores", () => {
    expect(evaluateFirst(first())).toEqual({
      variant: "classic",
      reasons: [],
      tally: { transformed: 1, "main:worker:Other": 1 },
      waited: [3],
    });
  });

  test("says when no request reached the fixture and what the worker reported", () => {
    expect(evaluateFirst(first({ effects: [], workerError: BLOCKED })).reasons).toEqual([
      {
        kind: "noEffect",
        text: `no request from ${SCRIPT} reached the fixture; the worker reported ${BLOCKED}`,
      },
    ]);
  });

  test("counts an unmarked first effect and unprefixed stores per store", () => {
    const outcome = evaluateFirst(
      first({
        effects: [FROM, "/me?from=sw-imported&__rec=e5-other"],
        databases: ["fixture-sw"],
        caches: { error: "No cache storage" },
      }),
    );
    expect(outcome.reasons).toEqual([
      { kind: "firstEffectBeforeMarker", text: `first effect without the marker: ${FROM}` },
      { kind: "unmarkedEffect", text: "effect without the marker: /me?from=sw-imported" },
      { kind: "storeUnprefixed:IndexedDB", text: "IndexedDB holds fixture-sw without the prefix" },
      { kind: "storeUnreadable", text: "CacheStorage unreadable: No cache storage" },
    ]);
    expect(kindsOf(first({ caches: [] }))).toEqual(["storeMissing"]);
  });

  test("says where the main script stopped short of being transformed", () => {
    const tab = paused(SCRIPT, { session: "tab", action: "continued", declared: undefined });
    const refused = { ...tab, session: "worker" as const, error: "Not allowed" };
    expect(kindsOf(first({ journal: journal([]) }))).toEqual(["notIntercepted"]);
    expect(evaluateFirst(first({ journal: journal([refused], false) })).reasons).toEqual([
      {
        kind: "notTransformed",
        text: `${SCRIPT} paused on the worker session (Other) but not fulfilled: Not allowed`,
      },
      { kind: "notReleased", text: `no paused worker target released for ${SCRIPT}` },
    ]);
    expect(evaluateFirst(first({ journal: journal([tab]) })).tally).toEqual({
      "main:tab:Other": 1,
    });
  });
});

describe("E5 imports", () => {
  const imported = (path: string, overrides: Partial<PausedEntry> = {}) =>
    paused(path, { role: "imported", action: "continued", declared: undefined, ...overrides });

  test("tallies where each import paused, with its resource type", () => {
    const entries = [
      paused("/sw-imports.js?variant=imports"),
      imported("/sw-main.js", { resourceType: "Script" }),
      imported("/sw-imported.js", { resourceType: "Script", session: "tab" }),
    ];
    const outcome = evaluateImports({
      variant: "importScripts",
      imports: ["/sw-main.js", "/sw-imported.js", "/sw-lazy.js"],
      transform: false,
      journal: journal(entries),
    });
    expect(outcome).toEqual({
      variant: "importScripts",
      reasons: [
        {
          kind: "importNotIntercepted",
          text: "/sw-lazy.js never paused on the tab or worker session",
        },
      ],
      tally: {
        imports: 3,
        "intercepted:worker": 1,
        "intercepted:tab": 1,
        notIntercepted: 1,
        "import:worker:Script": 1,
        "import:tab:Script": 1,
      },
      waited: [],
    });
  });

  test("requires every import fulfilled when Route B was asked to transform them", () => {
    const done = paused("/sw-main.js", { role: "imported", waitedMs: 4 });
    const left = imported("/sw-imported.js", { resourceType: "Script" });
    const outcome = evaluateImports({
      variant: "importScripts",
      imports: ["/sw-main.js", "/sw-imported.js"],
      transform: true,
      journal: journal([done, left]),
    });
    expect(outcome.reasons).toEqual([
      {
        kind: "importNotTransformed",
        text: "/sw-imported.js paused on the worker session (Script) but not fulfilled: continued",
      },
    ]);
    expect([outcome.tally.transformed, outcome.waited]).toEqual([1, [4]]);
  });
});

describe("E5 verdicts", () => {
  test("passes only when every sample passed and keeps counts, timings, and variants", () => {
    const passing = evaluateFirst(first());
    const failing = evaluateFirst(first({ variant: "module", effects: [], workerError: BLOCKED }));
    const kinds = ["noEffect", "storeUnprefixed:IndexedDB"];
    expect(verdictOf("first", [passing, passing], CHROME, { kinds })).toMatchObject({
      experiment: "E5",
      hypothesis: "first",
      verdict: "pass",
      samples: 2,
      method: "cdp-load-unpacked",
      counts: {
        samples: 2,
        passed: 2,
        noEffect: 0,
        "storeUnprefixed:IndexedDB": 0,
        transformed: 2,
      },
      timings: { pausedMs: { p50: 3, p95: 3, max: 3 } },
      variants: [{ name: "classic", verdict: "pass", samples: 2 }],
    });
    const failed = verdictOf("first", [passing, failing], CHROME, { kinds, label: "diagnostic" });
    const reason = `no request from ${SCRIPT} reached the fixture; the worker reported ${BLOCKED}`;
    expect(failed).toMatchObject({
      verdict: "fail",
      label: "diagnostic",
      error: `1 of 2 samples failed: ${reason} (1)`,
      counts: { samples: 2, passed: 1, noEffect: 1 },
      variants: [
        { name: "classic", verdict: "pass", samples: 1 },
        { name: "module", verdict: "fail", error: `1 of 1 samples failed: ${reason} (1)` },
      ],
    });
  });

  test("fails a hypothesis no sample ran for", () => {
    expect(verdictOf("offline", [], CHROME, { kinds: [] })).toMatchObject({
      verdict: "fail",
      error: "no sample ran",
      samples: 0,
    });
  });
});
