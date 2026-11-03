import { describe, expect, test } from "vite-plus/test";
import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { capabilityOf, evaluateSample, summarize, unavailable } from "./experiments/e3-samples.ts";
import type { E3Entry, E3Sample } from "./experiments/e3-samples.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "cdp-load-unpacked" };
const CONTEXT = { browser: CHROME, condition: "baseline" };
const SCRIPT = "/sw-main.js?variant=classic";
const FROM = `/me?from=${encodeURIComponent(SCRIPT)}`;
const NOT_ALLOWED = '{"code":-32000,"message":"Not allowed"}';
const PATCHED = { status: "installed", typeof: "object" };

function installed(marker: string, realmAgeMs = 1.5, caches = PATCHED) {
  return { marker, patches: { fetch: PATCHED, indexedDB: PATCHED, caches }, realmAgeMs };
}

function paused(overrides: Partial<E3Entry> = {}): E3Entry {
  return {
    type: "service_worker",
    url: `http://app.localhost:4600${SCRIPT}`,
    waitingForDebugger: true,
    bootstrapMs: 4,
    installed: installed("e3-m1"),
    released: true,
    pause: {
      steps: [
        { step: "Debugger.enable", result: "ok" },
        { step: "Debugger.setInstrumentationBreakpoint", result: "ok" },
        { step: "Debugger.paused", result: "instrumentation" },
        { step: "Runtime.evaluate typeof", result: "ok" },
        { step: "Debugger.removeBreakpoint", result: "ok" },
        { step: "Debugger.resume", result: "ok" },
      ],
      paused: true,
      pausedMs: 3,
      typeofAtPause: { caches: "object", CacheStorage: "function" },
      laterPauses: 0,
    },
    ...overrides,
  };
}

function sample(overrides: Partial<E3Sample> = {}): E3Sample {
  const marker = overrides.marker ?? "e3-m1";
  return {
    hypothesis: "before-script-execution",
    variant: "sw-classic",
    mode: "pause",
    marker,
    script: SCRIPT,
    store: "fixture-sw",
    effects: [`${FROM}&__rec=${marker}`, `/__marker?name=sw%3Async%3Afixture-sync&__rec=${marker}`],
    databases: [`__rec:${marker}:fixture-sw`],
    caches: [`__rec:${marker}:fixture-sw`, `__rec:${marker}:fixture-shell-v1`],
    entry: paused(),
    ...overrides,
  };
}

function watched(overrides: Partial<E3Sample> = {}): E3Sample {
  const entry = { ...paused(), waitingForDebugger: false, released: false, attachMs: 2 };
  delete entry.pause;
  return sample({ hypothesis: "direct-attach-race", mode: "watch", entry, ...overrides });
}

describe("E3 sample evaluation", () => {
  test("passes a worker bootstrapped at its instrumentation pause and marked everywhere", () => {
    expect(evaluateSample(sample())).toEqual({ passed: true, kinds: [], reasons: [] });
    expect(evaluateSample(watched())).toEqual({ passed: true, kinds: [], reasons: [] });
  });

  test("counts a worker attached running as a late attach when a pause was expected", () => {
    const entry = { ...paused(), waitingForDebugger: false };
    delete entry.pause;
    expect(evaluateSample(sample({ entry }))).toEqual({
      passed: false,
      kinds: ["lateAttach"],
      reasons: ["attached while running, not waiting for the debugger"],
    });
  });

  test("keeps Chrome's exact error for a refused breakpoint and names a worker never paused", () => {
    const entry = paused({ installed: undefined });
    entry.pause = {
      steps: [
        { step: "Debugger.enable", result: "ok" },
        { step: "Debugger.setInstrumentationBreakpoint", result: NOT_ALLOWED },
      ],
      paused: false,
      laterPauses: 0,
    };
    const outcome = evaluateSample(sample({ entry }));
    expect([outcome.kinds, outcome.reasons]).toEqual([
      ["breakpointRefused", "notPaused"],
      [`Debugger.setInstrumentationBreakpoint: ${NOT_ALLOWED}`, "no instrumentation pause"],
    ]);
  });

  test("reports a failed resume, a failed bootstrap, and a worker never released", () => {
    const entry = paused({ error: "Execution context was destroyed.", released: false });
    entry.pause?.steps.splice(-1, 1, { step: "Debugger.resume", result: NOT_ALLOWED });
    const outcome = evaluateSample(sample({ entry }));
    expect([outcome.kinds, outcome.reasons]).toEqual([
      ["notReleased", "bootstrapFailed"],
      [
        "never released",
        `Debugger.resume: ${NOT_ALLOWED}`,
        "bootstrap failed: Execution context was destroyed.",
      ],
    ]);
  });

  test("counts an unmarked first request, and a load whose worker never ran its top level", () => {
    const late = evaluateSample(watched({ effects: [FROM, `${FROM}&__rec=e3-m1`] }));
    expect([late.kinds, late.reasons]).toEqual([
      ["firstEffectBeforeMarker"],
      [`first effect without the marker: ${FROM}`],
    ]);
    const asleep = evaluateSample(watched({ effects: ["/__marker?name=sw%3Async&__rec=e3-m1"] }));
    expect([asleep.kinds, asleep.reasons]).toEqual([
      ["noEffect"],
      [`no top-level request from ${SCRIPT}`],
    ]);
  });

  test("finds a worker whose script URL a controlling, instrumented service worker marked", () => {
    const script = "/worker.js?type=classic";
    const from = encodeURIComponent(`${script}&__rec=e3-sw`);
    const outcome = evaluateSample(sample({ script, effects: [`/me?from=${from}&__rec=e3-m1`] }));
    expect(outcome).toEqual({ passed: true, kinds: [], reasons: [] });
  });

  test("ignores store names the origin held before the load but not a new unprefixed one", () => {
    const before = ["fixture-sw", "fixture-shell-v1"];
    const kept = { databases: ["fixture-sw", "__rec:e3-m1:fixture-sw"], preexisting: before };
    expect(evaluateSample(sample(kept)).passed).toBe(true);
    const outcome = evaluateSample(sample({ databases: ["fixture-sw"], preexisting: ["other"] }));
    expect(outcome.kinds).toEqual(["firstEffectBeforeMarker", "noEffect"]);
    expect(outcome.reasons).toEqual([
      "IndexedDB holds fixture-sw without the prefix",
      "IndexedDB has no fixture-sw under this marker",
    ]);
  });

  test("names a worker still running before a cold load and one Route A never attached", () => {
    const outcome = evaluateSample(watched({ stopped: false, entry: undefined }));
    expect([outcome.kinds, outcome.reasons]).toEqual([
      ["notStopped", "notAttached"],
      ["the worker was still running before the load", `Route A never attached ${SCRIPT}`],
    ]);
  });
});

describe("E3 verdicts", () => {
  test("passes with the condition, counts, per-mode timings, and variants", () => {
    const watch = watched({ variant: "watch" });
    if (watch.entry) watch.entry.bootstrapMs = 9;
    watch.stopMs = 120;
    const verdict = summarize("cold-start-navigation", [sample({ variant: "pause" }), watch], {
      ...CONTEXT,
      condition: "net-delay",
    });
    expect(verdict).toMatchObject({
      experiment: "E3",
      hypothesis: "cold-start-navigation",
      verdict: "pass",
      samples: 2,
      method: "cdp-load-unpacked",
      condition: "net-delay",
      lateAttaches: 0,
      variants: [
        { name: "pause", verdict: "pass", samples: 1 },
        { name: "watch", verdict: "pass", samples: 1 },
      ],
    });
    expect(verdict.counts).toMatchObject({
      samples: 2,
      passed: 2,
      lateAttaches: 0,
      firstEffectBeforeMarker: 0,
      notPaused: 0,
      breakpointRefused: 0,
      patchSkipped: 0,
      cachesMissingAtPause: 0,
      installedLate: 0,
    });
    expect(verdict.timings).toEqual({
      attachToBootstrapMs: { p50: 4, p95: 4, max: 4 },
      sightToBootstrapMs: { p50: 9, p95: 9, max: 9 },
      attachMs: { p50: 2, p95: 2, max: 2 },
      pausedMs: { p50: 3, p95: 3, max: 3 },
      realmAgeMs: { p50: 1.5, p95: 1.5, max: 1.5 },
      stopMs: { p50: 120, p95: 120, max: 120 },
    });
  });

  test("fails with every late attach, the patches installed late, and caches missing at the pause", () => {
    const running = { ...paused(), waitingForDebugger: false, installed: installed("e3-m1", 900) };
    const missing = { status: "skipped", typeof: "undefined" };
    const bare = paused({ installed: installed("e3-m1", 0.4, missing) });
    if (bare.pause) bare.pause.typeofAtPause = { caches: "undefined", CacheStorage: "undefined" };
    const samples = [
      sample({ hypothesis: "pre-existing-running", entry: running, effects: [FROM] }),
      sample({ entry: bare }),
      watched({ effects: [FROM] }),
    ];
    const verdict = summarize("pre-existing-running", samples, CONTEXT);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.error).toBe(
      `2 of 3 samples failed: attached while running, not waiting for the debugger (1); first effect without the marker: ${FROM} (2)`,
    );
    expect(verdict.lateAttaches).toBe(2);
    expect(verdict.counts).toMatchObject({
      samples: 3,
      passed: 1,
      lateAttaches: 2,
      lateAttach: 1,
      firstEffectBeforeMarker: 2,
      installedLate: 2,
      patchSkipped: 1,
      cachesMissingAtPause: 1,
    });
    expect(verdict.timings?.realmAgeMs).toEqual({ p50: 1.5, p95: 900, max: 900 });
  });

  test("an untestable hypothesis is unavailable with what was seen", () => {
    const counts = { samples: 5, woke: 0, syncAtRegistration: 5 };
    expect(unavailable("wake-without-tab", "never woke", CONTEXT, counts)).toEqual({
      experiment: "E3",
      hypothesis: "wake-without-tab",
      verdict: "unavailable",
      error: "never woke",
      chrome: CHROME.chrome,
      samples: 5,
      method: "cdp-load-unpacked",
      condition: "baseline",
      lateAttaches: 0,
      counts,
    });
    expect(summarize("before-script-execution", [], CONTEXT)).toMatchObject({
      verdict: "fail",
      error: "no sample ran",
      samples: 0,
    });
  });

  test("records a capability as allowed, or rejected with each distinct error counted", () => {
    const method = "cdp-load-unpacked";
    expect(capabilityOf("breakpoint", ["ok", "ok"], method)).toEqual({
      description: "breakpoint",
      status: "allowed",
      statuses: ["allowed"],
      method,
      details: [{ result: "ok", count: 2 }],
    });
    expect(capabilityOf("close", ["ok", NOT_ALLOWED, NOT_ALLOWED], method)).toEqual({
      description: "close",
      status: "rejected",
      statuses: ["allowed", "rejected"],
      method,
      details: [
        { result: "ok", count: 1 },
        { result: NOT_ALLOWED, count: 2 },
      ],
    });
    expect(capabilityOf("never sent", [], method).status).toBe("unavailable");
  });
});
