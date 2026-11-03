import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEAP_GROWTH_BUDGET_BYTES,
  accountLoss,
  checkBudget,
  createLossTally,
  pairLags,
  parseBenchArgs,
  percentiles,
  renderSummary,
  shapeReport,
} from "./bench-report.mjs";

const hook = (seq, type = "input") => ({
  producer: "hook:doc-1",
  seq,
  category: "dom",
  type,
  payload: {},
});
const gap = (fromSeq, toSeq, reason = "buffer-exhausted") => ({
  producer: "adapter:delivery",
  seq: 1,
  category: "gap",
  type: reason,
  payload: { producer: "hook:doc-1", fromSeq, toSeq, lost: toSeq - fromSeq + 1, reason },
});

test("percentiles use the nearest rank and answer null without samples", () => {
  assert.deepEqual(percentiles([5, 1, 4, 2, 3, 6, 7, 8, 9, 10]), {
    samples: 10,
    p50: 5,
    p95: 10,
    max: 10,
  });
  assert.deepEqual(percentiles([]), { samples: 0, p50: null, p95: null, max: null });
});

test("every hook sequence number delivered or named by a gap is accounted", () => {
  const tally = createLossTally();
  for (const event of [hook(1, "click"), hook(2), gap(3, 5), hook(6), hook(7)]) tally.add(event);
  assert.deepEqual(accountLoss(tally.totals(), 6), {
    pageInputs: 6,
    journaledInputs: 3,
    gapLost: 3,
    unaccountedInputs: 0,
    sequence: { producers: 1, delivered: 4, lost: 3, highest: 7, missing: 0, overcounted: 0 },
    gaps: { "buffer-exhausted": 1 },
    accounted: true,
  });
});

test("a gap the hook reported takes a sequence number of its own", () => {
  const tally = createLossTally();
  const reported = { ...gap(2, 4), producer: "hook:doc-1", seq: 5 };
  for (const event of [hook(1), reported, hook(6)]) tally.add(event);
  assert.deepEqual(accountLoss(tally.totals(), 5).sequence, {
    producers: 1,
    delivered: 3,
    lost: 3,
    highest: 6,
    missing: 0,
    overcounted: 0,
  });
});

test("inputs the page dispatched that neither the journal nor a gap names are unaccounted", () => {
  const tally = createLossTally();
  for (const event of [hook(1), hook(2), hook(4)]) tally.add(event);
  const loss = accountLoss(tally.totals(), 5);
  assert.equal(loss.unaccountedInputs, 2);
  assert.equal(loss.sequence.missing, 1);
  assert.equal(loss.accounted, false);
});

test("a sequence number named twice is overcounted, not accounted", () => {
  const tally = createLossTally();
  for (const event of [hook(1), hook(2), gap(2, 2, "delivery-lost")]) tally.add(event);
  const loss = accountLoss(tally.totals(), 2);
  assert.equal(loss.sequence.overcounted, 1);
  assert.equal(loss.accounted, false);
});

test("events of other producers are journaled but never enter the hook arithmetic", () => {
  const tally = createLossTally();
  tally.add({ producer: "cdp:page", seq: 9, category: "network", type: "request", payload: {} });
  tally.add(hook(1));
  assert.deepEqual(tally.totals().journaled, 2);
  assert.equal(accountLoss(tally.totals(), 1).sequence.highest, 1);
});

test("journal lag pairs page clicks and journaled clicks in order", () => {
  assert.deepEqual(pairLags([100, 200, 300], [150, 260]), {
    samples: 2,
    p50: 50,
    p95: 60,
    max: 60,
  });
});

test("the heap budget bounds what the capture added since it started", () => {
  const budget = HEAP_GROWTH_BUDGET_BYTES;
  assert.ok(budget > 0);
  assert.deepEqual(checkBudget(70_000_000 + budget - 1, 70_000_000), {
    budgetBytes: budget,
    heapBeforeBytes: 70_000_000,
    heapUsedBytes: 70_000_000 + budget - 1,
    heapGrowthBytes: budget - 1,
    headroomBytes: 1,
    withinBudget: true,
  });
  assert.equal(checkBudget(budget + 1, 0).withinBudget, false);
});

test("arguments default to 30 seconds per mode and all three modes", () => {
  assert.deepEqual(parseBenchArgs([]).modes, ["none", "normal", "deep"]);
  assert.equal(parseBenchArgs([]).seconds, 30);
  const parsed = parseBenchArgs(["--seconds", "10", "--modes", "normal", "--burst", "200"]);
  assert.deepEqual([parsed.seconds, parsed.modes, parsed.burst], [10, ["normal"], 200]);
  assert.throws(() => parseBenchArgs(["--modes", "loud"]), /Unknown mode loud/);
  assert.throws(() => parseBenchArgs(["--seconds", "0"]), /--seconds/);
});

const normal = {
  mode: "normal",
  seconds: 10,
  journalLagMs: { samples: 3, p50: 40, p95: 1200, max: 1200 },
  events: { journaled: 1000, perSecond: 100 },
  loss: { accounted: true },
  trace: { totalBytes: 5000, bytesPerSecond: 500 },
};

test("targets are measurements against the plan's targets, never pass or fail", () => {
  const report = shapeReport({
    options: { seconds: 10 },
    versions: {},
    modes: [{ mode: "none", seconds: 10, loss: null }, normal],
    memory: checkBudget(1, 0),
  });
  const progress = report.targets.find(({ id }) => id === "ui-progress");
  assert.deepEqual(progress.measured, { normal: 1200 });
  assert.equal(progress.targetMs, 1000);
  const soak = report.targets.find(({ id }) => id === "recording-30-minutes");
  assert.deepEqual([soak.measuredSeconds, soak.projectedTraceBytes], [10, 900_000]);
  for (const target of report.targets) assert.equal("met" in target, false);
  assert.deepEqual(report.checks, { lossAccounted: true, memoryBounded: true });
});

test("a mode with unaccounted loss or a heap over budget fails the checks", () => {
  const report = shapeReport({
    options: {},
    versions: {},
    modes: [{ ...normal, loss: { accounted: false } }],
    memory: checkBudget(HEAP_GROWTH_BUDGET_BYTES * 2, 0),
  });
  assert.deepEqual(report.checks, { lossAccounted: false, memoryBounded: false });
  assert.match(renderSummary(report), /memory bounded: no/);
});
