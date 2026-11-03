import { describe, expect, test } from "vite-plus/test";
import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { COLD_KINDS, RESTART_KINDS, SW_SCRIPT, e8Verdict } from "./experiments/e8-samples.ts";
import { childDetachesOf, evaluateCold, evaluateOthers } from "./experiments/e8-samples.ts";
import { evaluateRestart } from "./experiments/e8-samples.ts";
import type { ColdSample, RestartSample } from "./experiments/e8-samples.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "managed-policy" };
const MARKER = "e8-t5";
const MARKED = `__rec:${MARKER}:fixture-sw`;
const request = (marker?: string) =>
  `/me?from=${encodeURIComponent(SW_SCRIPT)}${marker ? `&__rec=${marker}` : ""}`;

function cold(overrides: Partial<ColdSample> = {}): ColdSample {
  return {
    marker: MARKER,
    effects: [request(MARKER)],
    database: MARKED,
    databases: [MARKED],
    caches: [MARKED, `__rec:${MARKER}:fixture-shell`],
    paused: true,
    ...overrides,
  };
}

const kinds = (sample: ColdSample) => evaluateCold(sample).reasons.map((reason) => reason.kind);

describe("evaluateCold", () => {
  test("passes a paused worker whose first request and stores carry the marker", () => {
    expect(kinds(cold())).toEqual([]);
  });

  test("names each way a cold start escaped the marker", () => {
    expect(kinds(cold({ paused: false }))).toEqual(["notPaused"]);
    expect(kinds(cold({ effects: [] }))).toEqual(["noEffect"]);
    expect(kinds(cold({ effects: [request(), request(MARKER)] }))).toEqual([
      "firstEffectBeforeMarker",
    ]);
    expect(kinds(cold({ database: "fixture-sw", databases: ["fixture-sw"] }))).toEqual([
      "databaseUnmarked",
      "databaseUnmarked",
    ]);
    expect(kinds(cold({ caches: [] }))).toEqual(["cacheUnmarked"]);
    expect(kinds(cold({ caches: { error: "-32601" } }))).toEqual(["storeUnreadable"]);
  });

  test("keeps the marker out of the reason text, so reasons group across samples", () => {
    const [reason] = evaluateCold(cold({ database: `__rec:${MARKER}:other` })).reasons;
    expect(reason?.text).toBe("the worker opened __rec:<marker>:other");
  });
});

const restart = (overrides: Partial<RestartSample> = {}): RestartSample => ({
  marker: MARKER,
  restarted: MARKED,
  effects: [request(MARKER)],
  ...overrides,
});
const restartKinds = (sample: RestartSample) =>
  evaluateRestart(sample).reasons.map((reason) => reason.kind);

describe("evaluateRestart", () => {
  test("passes a restart whose first request and database carry the marker", () => {
    expect(evaluateRestart(restart())).toMatchObject({ reasons: [], tally: { "ran:marked": 1 } });
  });

  test("fails a reload that never loaded, with nothing else to say about it", () => {
    expect(restartKinds(restart({ restarted: "held", effects: [] }))).toEqual(["held"]);
    expect(restartKinds(restart({ restarted: undefined }))).toEqual(["noReport"]);
  });

  test("fails a restart that loaded unmarked, and tallies what it opened", () => {
    const unmarked = restart({ restarted: "fixture-sw", effects: [request()] });
    expect(restartKinds(unmarked)).toEqual(["firstEffectBeforeMarker", "databaseUnmarked"]);
    expect(evaluateRestart(unmarked).tally).toEqual({ "ran:fixture-sw": 1 });
    expect(restartKinds(restart({ effects: [] }))).toEqual(["noEffect"]);
  });
});

describe("childDetachesOf", () => {
  test("lists each child session's detach outcome across the stop reports", () => {
    const report = (detaches: string[]) => ({
      targetId: "sw",
      sessions: detaches.map((detach, i) => ({ sessionId: `s${i}`, detach })),
    });
    const stops = [
      { result: [report(["ok"]), report([])] },
      { result: [report(["ok", "No session with given id"])] },
      { result: { error: "Not allowed" } },
      { result: [{ targetId: "older", close: "ok" }] },
    ];
    expect(childDetachesOf(stops)).toEqual(["ok", "ok", "No session with given id"]);
  });
});

describe("evaluateOthers", () => {
  test("fails once per target another client had attached", () => {
    const targets = [
      { type: "page", url: "about:blank", attached: false },
      { type: "page", url: "chrome://newtab/", attached: true },
    ];
    expect(evaluateOthers(targets)).toMatchObject({
      reasons: [
        { kind: "attachedBefore", text: "page chrome://newtab/ was attached before the isolator" },
      ],
      tally: { targets: 2 },
    });
  });
});

describe("e8Verdict", () => {
  test("stamps E8 and the strict condition and counts every kind", () => {
    const verdict = e8Verdict("a-cold-start", [evaluateCold(cold())], CHROME, COLD_KINDS);
    expect(verdict).toMatchObject({
      experiment: "E8",
      condition: "strict",
      verdict: "pass",
      method: "managed-policy",
      samples: 1,
    });
    expect(verdict.counts).toMatchObject({ passed: 1, notPaused: 0, cacheUnmarked: 0 });
  });

  test("fails with the counts of a held restart", () => {
    const held = evaluateRestart(restart({ restarted: "held", effects: [] }));
    const verdict = e8Verdict("b-restart", [held], CHROME, RESTART_KINDS);
    expect(verdict).toMatchObject({
      verdict: "fail",
      counts: { held: 1, noReport: 0, databaseUnmarked: 0 },
    });
  });
});
