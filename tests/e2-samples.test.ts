import { describe, expect, test } from "vite-plus/test";
import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { evaluateSample, summarize, unavailable } from "./experiments/e2-samples.ts";
import type { E2Sample } from "./experiments/e2-samples.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "cdp-load-unpacked" };
const SCRIPT = "/sw-main.js?variant=classic";
const FROM = `/me?from=${encodeURIComponent(SCRIPT)}`;

function sample(overrides: Partial<E2Sample> = {}): E2Sample {
  const marker = overrides.marker ?? "e2-m1";
  return {
    hypothesis: "service-worker-register",
    variant: "classic",
    marker,
    script: SCRIPT,
    store: "fixture-sw",
    effects: [`${FROM}&__rec=${marker}`],
    databases: [`__rec:${marker}:fixture-sw`],
    caches: [`__rec:${marker}:fixture-sw`, `__rec:${marker}:fixture-shell-v1`],
    entry: {
      type: "service_worker",
      url: `http://app.localhost:4600${SCRIPT}`,
      waitingForDebugger: true,
      bootstrapMs: 2,
      installed: { marker, installedAt: 1 },
      released: true,
    },
    ...overrides,
  };
}

describe("E2 sample evaluation", () => {
  test("passes a worker paused, bootstrapped, released, and marked in every effect and store", () => {
    expect(evaluateSample(sample())).toEqual({ passed: true, kinds: [], reasons: [] });
  });

  test("counts a first request without this marker as an effect before the marker", () => {
    for (const effects of [[FROM], [`${FROM}&__rec=e2-other`]]) {
      expect(evaluateSample(sample({ effects }))).toEqual({
        passed: false,
        kinds: ["firstEffectBeforeMarker"],
        reasons: [`first effect without the marker: ${FROM}`],
      });
    }
    const later = evaluateSample(
      sample({ effects: [`${FROM}&__rec=e2-m1`, "/me?from=sw-imported"] }),
    );
    expect([later.kinds, later.reasons]).toEqual([
      ["unmarkedEffect"],
      ["effect without the marker: /me?from=sw-imported"],
    ]);
  });

  test("counts a database or cache opened without the prefix as an effect before the marker", () => {
    const outcome = evaluateSample(
      sample({ databases: ["fixture-sw"], caches: ["fixture-sw", "fixture-shell-v1"] }),
    );
    expect(outcome.kinds).toEqual(["firstEffectBeforeMarker"]);
    expect(outcome.reasons).toEqual([
      "IndexedDB holds fixture-sw without the prefix",
      "Cache Storage holds fixture-sw without the prefix",
    ]);
  });

  test("names a worker that auto-attach never reported and one it did not pause", () => {
    const missing = evaluateSample(sample({ entry: undefined }));
    expect(missing.kinds).toEqual(["notAttached"]);
    expect(missing.reasons).toEqual([`no Target.attachedToTarget for ${SCRIPT}`]);
    const running = sample();
    if (running.entry) running.entry.waitingForDebugger = false;
    expect(evaluateSample(running).kinds).toEqual(["notPaused"]);
  });

  test("keeps Chrome's bootstrap error exactly and reports a worker left paused", () => {
    const failed = sample();
    if (failed.entry) {
      Object.assign(failed.entry, {
        installed: undefined,
        error: '{"code":-32000}',
        released: false,
      });
    }
    const outcome = evaluateSample(failed);
    expect(outcome.kinds).toEqual(["bootstrapFailed", "notReleased"]);
    expect(outcome.reasons).toEqual(['bootstrap failed: {"code":-32000}', "never released"]);
  });

  test("reports a worker that made no request and stores it could not read", () => {
    const outcome = evaluateSample(
      sample({ effects: [], databases: { error: "No document for given frame found" } }),
    );
    expect(outcome.kinds).toEqual(["noEffect", "storeUnreadable"]);
    expect(outcome.reasons).toEqual([
      `no request from ${SCRIPT} in the ledger`,
      "IndexedDB unreadable: No document for given frame found",
    ]);
  });
});

describe("E2 verdicts", () => {
  test("passes when every sample passed, with counts, variants, and bootstrap percentiles", () => {
    const samples = [1, 2, 3, 4].map((ms, index) => {
      const item = sample({ variant: index < 2 ? "classic" : "module", marker: `e2-m${index}` });
      if (item.entry) item.entry.bootstrapMs = ms;
      return item;
    });
    expect(summarize("service-worker-register", samples, CHROME)).toEqual({
      experiment: "E2",
      hypothesis: "service-worker-register",
      verdict: "pass",
      chrome: CHROME.chrome,
      samples: 4,
      method: CHROME.method,
      counts: {
        passed: 4,
        firstEffectBeforeMarker: 0,
        unmarkedEffect: 0,
        notAttached: 0,
        notPaused: 0,
        bootstrapFailed: 0,
        notReleased: 0,
        noEffect: 0,
        storeUnreadable: 0,
        patchSkipped: 0,
      },
      timings: { bootstrapMs: { p50: 2, p95: 4, max: 4 } },
      variants: [
        { name: "classic", verdict: "pass", samples: 2 },
        { name: "module", verdict: "pass", samples: 2 },
      ],
    });
  });

  test("counts the samples whose bootstrap skipped a patch, without changing the verdict", () => {
    const skipped = { status: "skipped", typeof: "undefined" };
    const samples = [sample(), sample()];
    const [first] = samples;
    if (first?.entry) first.entry.installed = { marker: "e2-m1", patches: { caches: skipped } };
    const verdict = summarize("service-worker-register", samples, CHROME);
    expect([verdict.verdict, verdict.counts?.passed, verdict.counts?.patchSkipped]).toEqual([
      "pass",
      2,
      1,
    ]);
  });

  test("fails with the first-effect-before-marker count and every distinct reason", () => {
    const late = sample({ variant: "module", effects: [FROM], databases: ["fixture-sw"] });
    const verdict = summarize("service-worker-register", [sample(), late, late], CHROME);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.counts).toMatchObject({ passed: 1, firstEffectBeforeMarker: 2 });
    expect(verdict.error).toBe(
      `2 of 3 samples failed: first effect without the marker: ${FROM} (2); IndexedDB holds fixture-sw without the prefix (2)`,
    );
    expect(verdict.variants?.map(({ name, verdict: outcome }) => [name, outcome])).toEqual([
      ["classic", "pass"],
      ["module", "fail"],
    ]);
  });

  test("a hypothesis without samples is a failure, and an untestable one is unavailable", () => {
    expect(summarize("dedicated-worker", [], CHROME)).toMatchObject({
      verdict: "fail",
      error: "no sample ran",
      samples: 0,
    });
    const diagnostic = { ...CHROME, label: "diagnostic" as const };
    expect(unavailable("nested-worker", "no nested worker", diagnostic)).toEqual({
      experiment: "E2",
      hypothesis: "nested-worker",
      verdict: "unavailable",
      error: "no nested worker",
      chrome: CHROME.chrome,
      samples: 0,
      method: CHROME.method,
      label: "diagnostic",
    });
  });
});
