import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "../browser/fixtures/extension.ts";
import { currentRunId, evidenceName } from "../browser/observer/observer.ts";
import { browserOf } from "./e1-aggregate.ts";
import { CONDITION, switchService, switchWorkers } from "./e6-loads.ts";
import type { Plan, Timing } from "./e6-loads.ts";
import { offlineService, restartChrome, suspendBackground, updateService } from "./e6-paths.ts";
import { e6Verdict, evaluateKept, evaluateSwitch, percentiles } from "./e6-samples.ts";
import { suspendedOutcome, unavailableVerdict, withRestarts } from "./e6-samples.ts";
import type { E6Context, Suspension, SwitchSample } from "./e6-samples.ts";
import { CONTROL, isolator, prepareFixture, test, writeSamples } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { sized } from "./samples.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.5; docs/poc/namespace-sessions/experiments/E6.md reports them.
// The harness drives pages and reads results: every chrome.debugger and DNR call runs in the isolator.
// 50 switches of the workers page give 100 worker samples; a service-worker restart can take 300 s.
const WORKER_ITERATIONS = sized(50);
const SERVICE_ITERATIONS = sized(2);
const PATH_ITERATIONS = sized(5);
const SUSPEND_ITERATIONS = sized(3);
const TIMING: Timing = CONDITION === "switch-early" ? "early" : "late";
// A slot pair per variant, so a warm run's kept stores never name another variant's slot.
const SERVICE_PLANS = [
  { selection: "extension-import", before: 0, after: 1 },
  { selection: "app-import", before: 2, after: 3 },
  { selection: "fetch-import", before: 4, after: 5 },
];
const WORKERS_PLAN = { selection: "sync-xhr", before: 6, after: 7 };
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const contextOf = (run: Run): E6Context => ({
  browser: browserOf(run.extension),
  condition: CONDITION,
});

async function record(verdicts: Verdict[]): Promise<void> {
  for (const verdict of verdicts) await appendVerdict(verdict);
  const variants = verdicts.flatMap(({ hypothesis, variants: own = [] }) =>
    own.map(({ name, verdict, error }) => [`${hypothesis}:${name}`, { verdict, error }]),
  );
  await mergeCapabilities({ e6Selection: Object.fromEntries(variants) });
  console.log(JSON.stringify(verdicts, null, 2));
}

const switchMsOf = (samples: SwitchSample[]) => samples.map((sample) => sample.switchMs);

/** Every service-worker selection and the workers page, switched once per iteration. */
async function switchSamples(run: Run, evidence: unknown[]) {
  const service: SwitchSample[] = [];
  const workers: SwitchSample[] = [];
  for (let iteration = 0; iteration < SERVICE_ITERATIONS; iteration += 1) {
    for (const plan of SERVICE_PLANS)
      service.push(await switchService(run, { ...plan, timing: TIMING }));
  }
  for (let iteration = 0; iteration < WORKER_ITERATIONS; iteration += 1) {
    workers.push(...(await switchWorkers(run, { ...WORKERS_PLAN, timing: TIMING })));
  }
  for (const sample of [...service, ...workers]) {
    evidence.push({ path: "switch", sample, outcome: evaluateSwitch(sample) });
  }
  return { service, workers };
}

/** The background closes itself between the switch and the next start of the workers page. */
async function suspendSamples(run: Run, evidence: unknown[]) {
  const outcomes = [];
  const suspensions: Suspension[] = [];
  const between = async () => void suspensions.push(await suspendBackground(run));
  // Service workers are left out: a soft update holds their restart (a-switch), not the suspension.
  const plan: Plan = { ...WORKERS_PLAN, timing: "late", between };
  for (let iteration = 0; iteration < SUSPEND_ITERATIONS; iteration += 1) {
    const samples = await switchWorkers(run, plan);
    const suspension = suspensions.at(-1);
    if (!suspension) throw new Error("a suspension sample is missing");
    const pair = samples.map((sample) => suspendedOutcome(evaluateSwitch(sample), suspension));
    outcomes.push(...pair);
    evidence.push({ path: "suspend", samples, suspension, pair });
  }
  return { outcomes, suspensions };
}

test.describe("E6: Route B selects the session without baking it into the script", () => {
  test.describe.configure({ timeout: 3_600_000 });

  test("a switch selects the new session's database for every worker kind @order-critical", async ({
    extension,
    observer,
  }) => {
    await prepareFixture(extension);
    const run: Run = { extension, context: observer.page.context() };
    const evidence: unknown[] = [];
    const { service, workers } = await switchSamples(run, evidence);
    await isolator(extension, "recnrunSelection.clear()");
    await observer.collectLedger(CONTROL);
    await writeSamples(observer.directory, evidence);

    const context = contextOf(run);
    const verdicts = [
      withRestarts(
        e6Verdict("a-switch", service.map(evaluateSwitch), switchMsOf(service), context),
        service,
      ),
      e6Verdict("c-workers", workers.map(evaluateSwitch), switchMsOf(workers), context),
    ];
    await record(verdicts);

    expect(
      verdicts.map(({ hypothesis, samples, condition }) => [hypothesis, samples, condition]),
    ).toEqual([
      ["a-switch", SERVICE_ITERATIONS * SERVICE_PLANS.length, CONDITION],
      ["c-workers", WORKER_ITERATIONS * 2, CONDITION],
    ]);
  });

  test("update(), an offline start, and a suspended background", async ({
    extension,
    observer,
  }) => {
    await prepareFixture(extension);
    const run: Run = { extension, context: observer.page.context() };
    const evidence: unknown[] = [];
    const updates = [];
    const offline = [];
    for (let iteration = 0; iteration < PATH_ITERATIONS; iteration += 1) {
      updates.push(await updateService(run, 4, 5));
      offline.push(await offlineService(run, 4, 5));
    }
    const suspended = await suspendSamples(run, evidence);
    await isolator(extension, "recnrunSelection.clear()");
    evidence.push(...updates.map((update) => ({ path: "update", ...update })));
    evidence.push(...offline.map((start) => ({ path: "offline", ...start })));
    await observer.collectLedger(CONTROL);
    await writeSamples(observer.directory, evidence);

    const context = contextOf(run);
    const updateSamples = updates.map((update) => update.sample);
    const activated = updates.flatMap((update) =>
      update.activatedMs === null ? [] : [update.activatedMs],
    );
    const update = e6Verdict(
      "b-update",
      updateSamples.map(evaluateSwitch),
      switchMsOf(updateSamples),
      context,
    );
    const offlineSamples = offline.map((start) => start.sample);
    const reached = suspended.suspensions.some((suspension) => suspension.suspended);
    const firstError = suspended.suspensions
      .map((s) => s.error ?? s.after.suspend?.attach)
      .find(Boolean);
    const verdicts = [
      activated.length > 0
        ? { ...update, timings: { ...update.timings, activatedMs: percentiles(activated) } }
        : update,
      e6Verdict("a-offline", offlineSamples.map(evaluateSwitch), [], context),
      reached
        ? e6Verdict("suspend", suspended.outcomes, [], context)
        : unavailableVerdict("suspend", firstError ?? "the background never stopped", context),
    ];
    await record(verdicts);

    expect(verdicts.map(({ hypothesis }) => hypothesis)).toEqual([
      "b-update",
      "a-offline",
      "suspend",
    ]);
  });

  test("a Chrome restart on the same profile keeps the installed slot", async ({
    headless,
  }, testInfo) => {
    if (headless) throw new Error("Browser tests run Chrome headed; set use.headless to false.");
    const restarted = await restartChrome(4);
    const context: E6Context = { browser: restarted.browser, condition: CONDITION };
    const { sample } = restarted;
    const verdict = sample
      ? withRestarts(e6Verdict("restart", [evaluateKept(sample)], [sample.switchMs], context), [
          sample,
        ])
      : unavailableVerdict("restart", restarted.error ?? "no sample", context);
    const counts: Record<string, number> = { ...verdict.counts };
    if (restarted.rulesAfter !== undefined) counts.rulesAfterRestart = restarted.rulesAfter;
    const recorded: Verdict = { ...verdict, counts };
    await writeSamples(join(ROOT, ".artifacts/evidence", currentRunId(), evidenceName(testInfo)), [
      restarted,
    ]);
    await record([recorded]);

    expect(recorded.hypothesis).toBe("restart");
  });
});
