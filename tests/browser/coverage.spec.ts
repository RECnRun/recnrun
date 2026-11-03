import {
  coverageOf,
  type CapturedEvent,
  type Event,
  type Step,
} from "../../packages/protocol/src/index.ts";
import { expect, test } from "./fixtures/capture.ts";
import { FIXTURE_ORIGIN } from "./fixtures/fixture-app.ts";
import { flowOf, replayStored } from "./fixtures/replay.ts";

const BURST = 1000;
const OPEN: Step = { id: "open", action: "navigate", url: `${FIXTURE_ORIGIN}/routes/replay` };

interface Range {
  fromSeq: number;
  toSeq: number;
  lost: number;
}

/** The gap ranges reported for one producer's sequence, by whichever side noticed the loss. */
const rangesOf = (events: readonly CapturedEvent[], producer: string): Range[] =>
  events
    .filter(({ category, payload }) => category === "gap" && payload["producer"] === producer)
    .map(({ payload }) => payload as unknown as Range);

/** Every number from 1 to the highest one seen, with how many times a delivery or a gap names it. */
function namedTimes(seqs: readonly number[], ranges: readonly Range[]): Map<number, number> {
  const last = Math.max(...seqs, ...ranges.map(({ toSeq }) => toSeq));
  const named = new Map<number, number>();
  for (let seq = 1; seq <= last; seq += 1) named.set(seq, 0);
  const mark = (seq: number) => named.set(seq, (named.get(seq) ?? 0) + 1);
  for (const seq of seqs) mark(seq);
  for (const { fromSeq, toSeq } of ranges)
    for (let seq = fromSeq; seq <= toSeq; seq += 1) mark(seq);
  return named;
}

const gapsOf = (events: readonly Event[]) => events.filter(({ category }) => category === "gap");

test.describe("with a 10-message hook buffer", () => {
  test.use({ captureExtras: { observerBuffer: 10 } });

  test("gap events account for every sequence number a burst of 1000 events lost", async ({
    app,
    captured,
  }) => {
    const page = await app.open("burst");
    const producer = `hook:${await captured.documentOf(page)}`;
    await page.getByTestId("burst-button").click();
    await expect(page.getByTestId("burst-log")).toHaveText(`Dispatched ${BURST} input events`);
    await expect.poll(() => rangesOf(captured.events, producer).length).toBeGreaterThan(0);
    // Leaving the page ends its document, so nothing it sent can still be on its way.
    await page.goto(`${FIXTURE_ORIGIN}/routes/form`);
    const events = (await captured.finish()).events as CapturedEvent[];
    const delivered = events.filter((event) => event.producer === producer);
    const ranges = rangesOf(events, producer);
    const named = namedTimes(
      delivered.map(({ seq }) => seq),
      ranges,
    );
    console.log(`${delivered.length} delivered and ${ranges.length} gaps of ${producer}`);
    expect(
      [...named].filter(([, times]) => times !== 1),
      "each number named once",
    ).toEqual([]);
    for (const { fromSeq, toSeq, lost } of ranges) expect(lost).toBe(toSeq - fromSeq + 1);
    const inputs = delivered.filter(({ type }) => type === "input").length;
    const lost = ranges.reduce((sum, range) => sum + range.lost, 0);
    expect(lost).toBeGreaterThan(0);
    // A gap can also cover the click's own messages, so only the sequence check above is exact.
    expect(inputs).toBeLessThanOrEqual(BURST);
    expect(inputs + lost, "every input is delivered or counted lost").toBeGreaterThanOrEqual(BURST);
    const coverage = coverageOf("capture-spec", events);
    expect(coverage.events, "every line that is not a gap").toBe(
      events.length - gapsOf(events).length,
    );
    expect(coverage.gaps).toContainEqual({
      reason: "buffer-exhausted",
      gaps: gapsOf(events).filter(({ type }) => type === "buffer-exhausted").length,
      lostEvents: lost,
    });
    expect(coverage.surfaces).toContainEqual(
      expect.objectContaining({ surface: "dom-events", status: "partial" }),
    );
  });
});

test("killing Chrome mid-run journals a connection-lost gap that coverage.json counts", async ({
  chrome,
}) => {
  const wait: Step = {
    id: "wait",
    assertion: "visible",
    target: { testId: "never-there" },
    timeoutMs: 10_000,
  };
  let killed = false;
  const later: Step = { id: "later", action: "click", target: { testId: "never-there" } };
  const flow = flowOf("killed", [OPEN, wait, later]);
  const { outcome, stored } = await replayStored(chrome.wsEndpoint, flow, {
    observe: (event) => {
      if (killed || event.type !== "step.started" || event.stepId !== "wait") return;
      killed = true;
      process.kill(chrome.pid, "SIGKILL");
    },
  });
  expect(killed).toBe(true);
  expect(outcome.status).toBe("interrupted");
  expect(outcome.exitCode).toBe(2);
  const cut = outcome.steps.find(({ stepId }) => stepId === "wait");
  expect(cut).toMatchObject({ status: "cancelled", error: { code: "connection-lost" } });
  // The assertion polls for 10 s unless the loss cuts it short.
  expect(cut?.durationMs).toBeLessThan(5_000);
  expect(stored.summary).toMatchObject({ status: "interrupted", exitCode: 2 });
  expect(stored.summary?.counts).toMatchObject({ passed: 1, cancelled: 2 });
  expect(stored.summary?.failures).toEqual([
    { stepId: "wait", message: expect.stringContaining("collector gap connection-lost") },
  ]);
  expect(gapsOf(stored.journal.events)).toEqual([
    expect.objectContaining({
      producer: "adapter:connection",
      component: "collector",
      type: "connection-lost",
      payload: expect.objectContaining({ reason: "connection-lost" }),
    }),
  ]);
  expect(stored.coverage).toEqual(coverageOf(stored.manifest.runId, stored.journal.events));
  expect(stored.coverage?.gaps).toEqual([{ reason: "connection-lost", gaps: 1, lostEvents: 0 }]);
});

test("the counts in coverage.json reconcile with the run's journal", async ({ chrome }) => {
  const click: Step = {
    id: "click",
    action: "click",
    target: { testId: "never-there" },
    timeoutMs: 1_000,
  };
  const { stored } = await replayStored(chrome.wsEndpoint, flowOf("reconciled", [OPEN, click]));
  const { journal, coverage } = stored;
  expect(coverage).toEqual(coverageOf(stored.manifest.runId, journal.events));
  expect(coverage?.events).toBe(journal.events.length);
  const snapshots = journal.events.filter(({ category }) => category === "snapshot").length;
  expect(snapshots).toBeGreaterThan(0);
  // The replay journals its own tab's navigation and requests next to the step snapshots.
  expect(coverage?.surfaces).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ surface: "dom-screen", status: "implemented", events: snapshots }),
      expect.objectContaining({ surface: "navigation", events: expect.any(Number) }),
      expect.objectContaining({ surface: "network", events: expect.any(Number) }),
    ]),
  );
  for (const surface of coverage?.surfaces ?? [])
    expect(surface.events, surface.surface).toBeGreaterThan(0);
  expect(coverage?.gaps ?? []).toEqual([]);
});
