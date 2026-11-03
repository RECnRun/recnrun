import { describe, expect, test } from "vite-plus/test";
import type { E1Browser } from "./experiments/e1-aggregate.ts";
import { e6Verdict, evaluateKept, evaluateSwitch, nameOf } from "./experiments/e6-samples.ts";
import { suspendedOutcome, unavailableVerdict, withRestarts } from "./experiments/e6-samples.ts";
import type { Suspension, SwitchSample } from "./experiments/e6-samples.ts";

const CHROME: E1Browser = { chrome: "Google Chrome 156.0.8078.79", method: "cdp-load-unpacked" };
const CONTEXT = { browser: CHROME, condition: "switch-late" };
const STORE = "fixture-sw";
const BEFORE = nameOf("slot-4", STORE);
const AFTER = nameOf("slot-5", STORE);

function sample(overrides: Partial<SwitchSample> = {}): SwitchSample {
  return {
    realm: "service",
    selection: "fetch-import",
    timing: "late",
    before: "slot-4",
    after: "slot-5",
    store: STORE,
    first: [BEFORE],
    second: [BEFORE],
    started: true,
    switchMs: 2,
    ...overrides,
  };
}

const kinds = (s: SwitchSample) => evaluateSwitch(s).reasons.map((reason) => reason.kind);

describe("evaluateSwitch", () => {
  test("passes when the start after the switch opened the new slot's database", () => {
    const outcome = evaluateSwitch(sample({ second: [BEFORE, AFTER] }));
    expect(outcome).toEqual({
      variant: "service:fetch-import",
      reasons: [],
      tally: { fresh: 1 },
      waited: [],
    });
  });

  test("passes when the restarted worker's requests carry the new slot", () => {
    expect(kinds(sample({ running: ["slot-5"] }))).toEqual([]);
  });

  test("a worker that still runs as the old slot is stale, even next to an unmarked version", () => {
    const outcome = evaluateSwitch(sample({ second: [BEFORE, STORE], running: ["slot-4"] }));
    expect(outcome.reasons).toEqual([
      { kind: "stale", text: `ran as slot-4 after the switch to slot-5: [${BEFORE}, ${STORE}]` },
    ]);
    expect(outcome.tally).toEqual({ notFresh: 1, unprefixedAfter: 1 });
  });

  test("names the stores when no request shows which slot the worker ran", () => {
    expect(kinds(sample())).toEqual(["stale"]);
    expect(kinds(sample({ second: [BEFORE, STORE] }))).toEqual(["unmarked"]);
    expect(kinds(sample({ started: false }))).toEqual(["notRestarted"]);
    expect(kinds(sample({ realm: "dedicated", store: "fixture-dedicated" }))).toEqual([
      "firstNotSelected",
    ]);
  });

  test("a first start that opened neither slot fails with what the page reported", () => {
    const error =
      "TypeError: Failed to register a ServiceWorker: ServiceWorker script evaluation failed";
    const outcome = evaluateSwitch(sample({ first: [], second: [], error }));
    expect(outcome.reasons).toEqual([
      { kind: "firstNotSelected", text: `first start opened []: ${error}` },
    ]);
  });

  test("an early switch the first start already took passes only on the worker's own requests", () => {
    const early = sample({
      timing: "early",
      first: [AFTER],
      second: [AFTER],
      beforeActivated: true,
    });
    expect(evaluateSwitch({ ...early, running: ["slot-5"] }).tally).toEqual({
      fresh: 1,
      firstTookAfter: 1,
      switchedBeforeActivated: 1,
    });
    // The database was there before the switch, so it says nothing about the second start.
    const unproven = evaluateSwitch(early);
    expect(unproven.reasons).toEqual([
      {
        kind: "notObserved",
        text: `the first start had already opened ${AFTER}; no request carried slot-5 after the switch to slot-5: [${AFTER}]`,
      },
    ]);
    expect(unproven.tally).toEqual({ notFresh: 1, firstTookAfter: 1, switchedBeforeActivated: 1 });
  });

  test("a database already present never outranks a failed, stalled, or stale second start", () => {
    const present = { first: [AFTER], second: [AFTER] };
    expect(
      kinds(sample({ ...present, started: false, stalled: true, running: ["slot-4"] })),
    ).toEqual(["stale"]);
    expect(kinds(sample({ ...present, stalled: true }))).toEqual(["stalled"]);
    expect(kinds(sample({ ...present, started: false }))).toEqual(["notRestarted"]);
    expect(kinds(sample({ second: [AFTER, STORE] }))).toEqual(["unmarked"]);
  });

  test("a soft update before the restart and an unsettled registration are tallied", () => {
    const updated = sample({ second: [BEFORE, STORE], scriptFetches: 2, settled: false });
    expect(evaluateSwitch(updated).tally).toEqual({
      notFresh: 1,
      unprefixedAfter: 1,
      softUpdated: 1,
      unsettled: 1,
    });
    expect(
      evaluateKept(sample({ running: ["slot-4"], scriptFetches: 1, settled: true })).tally,
    ).toEqual({ kept: 1, "ran:slot-4": 1 });
  });

  test("a restart whose navigation never committed is stalled unless its requests named a slot", () => {
    const stalled = sample({ second: [BEFORE, STORE], stalled: true, restartMs: 20_004 });
    expect(evaluateSwitch(stalled).reasons).toEqual([
      {
        kind: "stalled",
        text: "the navigation that restarts the worker had not committed after 20004 ms",
      },
    ]);
    expect(evaluateKept(stalled).reasons.map((reason) => reason.kind)).toEqual(["stalled"]);
    expect(kinds(sample({ stalled: true, running: ["slot-4"] }))).toEqual(["stale"]);
  });

  test("unreadable stores and a missing database are their own reasons", () => {
    expect(kinds(sample({ first: { error: "no inventory of the app origin" } }))).toEqual([
      "storeUnreadable",
    ]);
    expect(kinds(sample({ second: { error: "no inventory of the app origin" } }))).toEqual([
      "storeUnreadable",
    ]);
    expect(kinds(sample({ second: ["fixture-page"] }))).toEqual(["noStore"]);
  });
});

describe("evaluateKept", () => {
  test("passes when the restarted worker's requests carry the slot it was installed with", () => {
    const outcome = evaluateKept(sample({ running: ["slot-4"] }));
    expect(outcome.reasons).toEqual([]);
    expect(outcome.tally).toEqual({ kept: 1, "ran:slot-4": 1 });
  });

  test("fails when the worker ran as another slot, or no request showed a slot", () => {
    expect(evaluateKept(sample({ running: ["slot-5"] })).reasons).toEqual([
      { kind: "notObserved", text: "the worker started again but ran as slot-5" },
    ]);
    expect(evaluateKept(sample()).reasons).toEqual([
      { kind: "notObserved", text: "the worker started again but no request carried a marker" },
    ]);
    expect(evaluateKept(sample({ started: false })).reasons[0]?.kind).toBe("notRestarted");
    expect(evaluateKept(sample({ second: [BEFORE, STORE] })).reasons[0]?.kind).toBe("unmarked");
  });
});

function suspension(overrides: Partial<Suspension> = {}): Suspension {
  return {
    suspended: true,
    resumed: true,
    before: { ruleIds: [6100, 6101] },
    after: { ruleIds: [6100, 6101], suspend: { attach: "ok" } },
    ...overrides,
  };
}

describe("suspendedOutcome", () => {
  test("keeps a start that followed a real suspension with the rules intact", () => {
    const outcome = suspendedOutcome(evaluateKept(sample({ running: ["slot-4"] })), suspension());
    expect(outcome.reasons).toEqual([]);
    expect(outcome.tally).toMatchObject({ kept: 1, suspended: 1, resumed: 1 });
  });

  test("fails with Chrome's refusal when the background could not stop itself", () => {
    const refused = "Cannot access a chrome-extension:// URL of different extension";
    const after = { ruleIds: [6100, 6101], suspend: { attach: refused } };
    const outcome = suspendedOutcome(
      evaluateKept(sample({ running: ["slot-4"] })),
      suspension({ suspended: false, resumed: false, after }),
    );
    expect(outcome.reasons).toEqual([
      { kind: "notSuspended", text: `attach to its own target: ${refused}` },
    ]);
  });

  test("fails when the rules did not survive the resume", () => {
    const after = { ruleIds: [], suspend: { attach: "ok" } };
    const outcome = suspendedOutcome(
      evaluateKept(sample({ running: ["slot-4"] })),
      suspension({ after }),
    );
    expect(outcome.reasons.map((reason) => reason.kind)).toEqual(["rulesLost"]);
  });
});

describe("e6Verdict", () => {
  test("records E6, the condition, stale starts as late attaches, and the switch timings", () => {
    const outcomes = [
      evaluateSwitch(sample({ running: ["slot-5"] })),
      evaluateSwitch(sample({ running: ["slot-4"] })),
      evaluateSwitch(sample({ selection: "app-import", first: [], second: [] })),
    ];
    const verdict = e6Verdict("a-switch", outcomes, [2, 4, 9], CONTEXT);
    expect(verdict).toMatchObject({
      experiment: "E6",
      hypothesis: "a-switch",
      verdict: "fail",
      condition: "switch-late",
      lateAttaches: 1,
      samples: 3,
      timings: { switchMs: { p50: 4, p95: 9, max: 9 } },
    });
    expect(verdict.counts).toMatchObject({ passed: 1, stale: 1, firstNotSelected: 1, unmarked: 0 });
    expect(verdict.variants?.map(({ name, verdict: own }) => [name, own])).toEqual([
      ["service:fetch-import", "fail"],
      ["service:app-import", "fail"],
    ]);
  });

  test("adds the restarts' navigation timings when samples measured them", () => {
    const verdict = e6Verdict("a-switch", [], [], CONTEXT);
    expect(withRestarts(verdict, [sample()])).toBe(verdict);
    const timed = withRestarts(verdict, [
      sample({ restartMs: 300 }),
      sample({ restartMs: 20_000 }),
    ]);
    expect(timed.timings).toEqual({ restartMs: { p50: 300, p95: 20_000, max: 20_000 } });
  });

  test("passes when every sample passed, and an unreachable hypothesis is unavailable", () => {
    const passed = e6Verdict(
      "c-workers",
      [evaluateSwitch(sample({ running: ["slot-5"] }))],
      [],
      CONTEXT,
    );
    expect([passed.verdict, passed.timings, passed.lateAttaches]).toEqual(["pass", undefined, 0]);
    expect(unavailableVerdict("restart", "relaunch failed", CONTEXT)).toEqual({
      experiment: "E6",
      hypothesis: "restart",
      verdict: "unavailable",
      error: "relaunch failed",
      chrome: CHROME.chrome,
      method: CHROME.method,
      samples: 0,
      condition: "switch-late",
    });
  });
});
