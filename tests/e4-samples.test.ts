import { describe, expect, test } from "vite-plus/test";
import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { evaluateSample, summarize } from "./experiments/e4-samples.ts";
import type { E4Sample } from "./experiments/e4-samples.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "cdp-load-unpacked" };
const SCRIPT = "/sw-main.js?variant=classic";
const FROM = `/me?from=${encodeURIComponent(SCRIPT)}`;
const REFUSED = "Runtime.terminateExecution is not allowed for untrusted clients";

function sample(overrides: Partial<E4Sample> = {}): E4Sample {
  const restartMarker = overrides.restartMarker ?? "e4-r1";
  return {
    mechanism: "close-target",
    variant: "classic",
    trigger: "navigation",
    marker: "e4-m1",
    restartMarker,
    script: SCRIPT,
    stopCommandMs: 3,
    unlistedMs: 40,
    beforeTrigger: [],
    afterTrigger: [`${FROM}&__rec=${restartMarker}`],
    restartMs: 120,
    restart: {
      observedBy: "auto-attach",
      waitingForDebugger: true,
      installed: { marker: restartMarker },
      released: true,
    },
    registrationKept: true,
    precacheKept: true,
    scriptFetches: ["/sw-main.js?variant=classic"],
    ...overrides,
  };
}

const PASSED = { passed: true, stopped: true, restartedUnsolicited: false, reasons: [] };

describe("E4 sample evaluation", () => {
  test("passes a worker that stopped and whose restart the extension bootstrapped first", () => {
    expect(evaluateSample(sample())).toEqual({ ...PASSED, restarted: true, observed: true });
  });

  test("passes a stop that nothing restarts, such as an unregistered worker", () => {
    const outcome = evaluateSample(
      sample({ mechanism: "unregister", afterTrigger: [], restart: undefined }),
    );
    expect(outcome).toEqual({ ...PASSED, restarted: false, observed: false });
  });

  test("keeps Chrome's refusal and a target that stayed listed", () => {
    const refused = evaluateSample(
      sample({ mechanism: "terminate-execution", stopError: REFUSED, unlistedMs: null }),
    );
    expect([refused.passed, refused.stopped, refused.reasons]).toEqual([
      false,
      false,
      [`stop refused: ${REFUSED}`],
    ]);
    expect(evaluateSample(sample({ unlistedMs: null })).reasons).toEqual([
      "the target stayed listed",
    ]);
  });

  test("counts a fresh start of the script before the trigger as unsolicited", () => {
    const outcome = evaluateSample(sample({ beforeTrigger: [`${FROM}&__rec=e4-m1`] }));
    expect([outcome.passed, outcome.restartedUnsolicited, outcome.reasons]).toEqual([
      false,
      true,
      ["the worker started again before the trigger"],
    ]);
    const note = evaluateSample(sample({ beforeTrigger: ["/__marker?name=sw%3Async%3Ax"] }));
    expect(note.restartedUnsolicited).toBe(false);
  });

  test("does not count a restart whose first request ran before the bootstrap", () => {
    const outcome = evaluateSample(sample({ afterTrigger: [FROM, `${FROM}&__rec=e4-r1`] }));
    expect([outcome.restarted, outcome.observed, outcome.reasons]).toEqual([
      true,
      false,
      ["the restarted worker's first request lacks the restart marker"],
    ]);
  });

  test("names a restart the extension missed, saw running, or left paused", () => {
    expect(evaluateSample(sample({ restart: undefined })).reasons).toEqual([
      "the extension never saw the restart",
    ]);
    const restart = { observedBy: "auto-attach" as const, waitingForDebugger: false };
    const running = evaluateSample(sample({ restart: { ...restart, released: false } }));
    expect(running.reasons).toEqual([
      "the restart attached while running",
      "restart bootstrap without the marker",
      "the restarted worker was never released",
    ]);
    const failed = { ...restart, waitingForDebugger: true, released: true, error: "boom" };
    expect(evaluateSample(sample({ restart: failed })).reasons).toEqual([
      "restart bootstrap failed: boom",
    ]);
    const watched = { observedBy: "reload-watch" as const, installed: { marker: "e4-r1" } };
    expect(evaluateSample(sample({ restart: { ...watched, released: true } })).observed).toBe(true);
  });

  test("passes a held worker only when it paused and made no request until released", () => {
    const held = sample({
      mechanism: "debugger-pause",
      paused: true,
      unlistedMs: null,
      afterTrigger: [],
      restart: undefined,
    });
    expect(evaluateSample(held)).toEqual({ ...PASSED, restarted: false, observed: false });
    expect(evaluateSample({ ...held, paused: false }).reasons).toEqual([
      "Debugger.paused never came",
    ]);
    const busy = evaluateSample({ ...held, afterTrigger: ["/__marker?name=sw%3Async%3Ax"] });
    expect(busy.reasons).toEqual(["the worker made requests while held"]);
  });
});

describe("E4 verdicts", () => {
  test("passes with counts, timings, and a variant per script variant and trigger", () => {
    const samples = [
      sample(),
      sample({ trigger: "sync", stopCommandMs: 5, unlistedMs: 60, restartMs: 200 }),
      sample({
        variant: "module",
        restartMs: undefined,
        afterTrigger: [],
        restart: undefined,
        precacheKept: false,
        scriptFetches: [],
      }),
    ];
    expect(summarize("close-target", samples, CHROME)).toEqual({
      experiment: "E4",
      hypothesis: "close-target",
      verdict: "pass",
      chrome: CHROME.chrome,
      samples: 3,
      method: CHROME.method,
      counts: {
        samples: 3,
        stops: 3,
        restartsUnsolicited: 0,
        restarts: 2,
        restartObservedBeforeFirstStatement: 2,
        registrationKept: 3,
        precacheKept: 2,
        scriptFetchedAfterStop: 2,
        navigationsHeld: 0,
      },
      timings: {
        stopCommandMs: { p50: 3, p95: 5, max: 5 },
        unlistedMs: { p50: 40, p95: 60, max: 60 },
        restartMs: { p50: 120, p95: 200, max: 200 },
      },
      variants: [
        { name: "classic/navigation", verdict: "pass", samples: 1 },
        { name: "classic/sync", verdict: "pass", samples: 1 },
        { name: "module/navigation", verdict: "pass", samples: 1 },
      ],
    });
  });

  test("fails a refused mechanism with Chrome's error and no timings it never measured", () => {
    const refused = sample({
      mechanism: "terminate-execution",
      trigger: "none",
      stopError: REFUSED,
      stopCommandMs: undefined,
      unlistedMs: null,
      afterTrigger: [],
      restartMs: undefined,
      restart: undefined,
    });
    const verdict = summarize("terminate-execution", [refused, refused, refused], CHROME);
    expect(verdict).toMatchObject({
      verdict: "fail",
      error: `3 of 3 samples failed: stop refused: ${REFUSED} (3)`,
      counts: { samples: 3, stops: 0, restarts: 0 },
      variants: [{ name: "classic/none", verdict: "fail", samples: 3 }],
    });
    expect(verdict.timings).toBeUndefined();
    expect(summarize("unregister", [], CHROME)).toMatchObject({
      verdict: "fail",
      error: "no sample ran",
    });
  });

  test("counts a navigation the held worker never answered", () => {
    const held = sample({
      mechanism: "debugger-pause",
      paused: true,
      afterTrigger: [],
      restart: undefined,
      navigationFinished: false,
    });
    expect(summarize("debugger-pause", [held], CHROME).counts).toMatchObject({
      navigationsHeld: 1,
      restarts: 0,
    });
  });
});
