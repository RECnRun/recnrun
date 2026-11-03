import { writeFile } from "node:fs/promises";
import { expect, test } from "../browser/fixtures/strict-lab.ts";
import type { StrictExtension } from "../browser/fixtures/strict-lab.ts";
import { APP } from "../browser/fixtures/strict-steps.ts";
import { findWindow } from "../browser/fixtures/x-display.ts";
import { capabilityOf } from "./e3-samples.ts";
import type { Outcome } from "./e5-samples.ts";
import { SWITCH_KINDS, evaluateSwitch } from "./e6-samples.ts";
import { browserOf, coldSample, restartSample, switchSample } from "./e8-loads.ts";
import type { Lab } from "./e8-loads.ts";
import { COLD_KINDS, CONDITION, OTHER_KINDS, RESTART_KINDS, e8Verdict } from "./e8-samples.ts";
import { childDetachesOf, evaluateCold, evaluateOthers, evaluateRestart } from "./e8-samples.ts";
import { control } from "./page-loads.ts";
import { sized } from "./samples.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

// Hypotheses of the strict lab; docs/poc/namespace-sessions/experiments/E8.md reports them.
// Chrome runs without any remote debugging flag and the isolator is installed by policy, so the
// isolator is the only debugger client: the CDP runs' harness session no longer resumes anything.
const COLD_SAMPLES = sized(20);
const RESTART_SAMPLES = sized(10);
const SWITCH_SAMPLES = sized(10);
const RUN = Date.now().toString(36);
const SWITCH_SLOTS = { before: 6, after: 7 };

async function labOf(strict: StrictExtension): Promise<Lab> {
  test.info().annotations.push({ type: "chrome", description: strict.chrome.version });
  await control("/__network?mode=online");
  await control("/__ledger/reset");
  return { strict, window: await findWindow(" - Google Chrome$") };
}

async function finish(verdict: Verdict, evidence: unknown[], samples: number): Promise<void> {
  await writeFile(test.info().outputPath("samples.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await appendVerdict(verdict);
  console.log(JSON.stringify(verdict, null, 2));
  expect([verdict.samples, verdict.condition], verdict.hypothesis).toEqual([samples, CONDITION]);
  if (verdict.verdict === "pass") expect(verdict.counts?.passed).toBe(verdict.samples);
}

async function repeat<T>(times: number, take: () => Promise<T>): Promise<T[]> {
  const samples: T[] = [];
  for (let sample = 0; sample < times; sample += 1) samples.push(await take());
  return samples;
}

test.describe("E8: Route A and B in Chrome without CDP, the isolator installed by policy", () => {
  test.describe.configure({ timeout: 1_800_000 });

  test.describe("Route A", () => {
    test.use({
      strictOptions: {
        lab: { marker: `e8-${RUN}`, arm: { origin: APP, pauseBeforeScript: true, clear: true } },
      },
    });

    test("d-other-clients: no target is attached before the isolator arms a tab", async ({
      strict,
    }) => {
      await labOf(strict);
      const targets = strict.sink.loaded.find((l) => l.id === strict.extensionId)?.targets ?? [];
      const outcome = evaluateOthers(targets);
      const verdict = e8Verdict("d-other-clients", [outcome], browserOf(strict), OTHER_KINDS);
      await finish(verdict, [targets], 1);
    });

    test("a-cold-start: an armed tab holds a cold service worker at its first statement @order-critical", async ({
      strict,
    }) => {
      const lab = await labOf(strict);
      const samples = await repeat(COLD_SAMPLES, () => coldSample(lab));
      const outcomes: Outcome[] = samples.map(evaluateCold);
      const verdict = e8Verdict("a-cold-start", outcomes, browserOf(strict), COLD_KINDS);
      await finish(verdict, samples, COLD_SAMPLES);
    });

    test("b-restart: a reload after the lab's closeTarget restarts the worker marked", async ({
      strict,
    }) => {
      const lab = await labOf(strict);
      const samples = await repeat(RESTART_SAMPLES, () => restartSample(lab));
      const outcomes = samples.map(evaluateRestart);
      const detaches = samples.flatMap(({ trace }) => childDetachesOf(trace.stops));
      const description =
        "Target.detachFromTarget, on the tab's session, of its child session on a closed service worker";
      await mergeCapabilities({
        debugger: {
          "worker-child-session-detach": capabilityOf(description, detaches, strict.method),
        },
      });
      const verdict = e8Verdict("b-restart", outcomes, browserOf(strict), RESTART_KINDS);
      await finish(verdict, samples, RESTART_SAMPLES);
    });
  });

  test.describe("Route B", () => {
    test.use({
      strictOptions: {
        lab: {
          marker: `e8b-${RUN}`,
          arm: {
            origin: APP,
            route: "b",
            urlPattern: "*worker.js?type=*",
            selection: "sync-xhr",
            pauseBeforeScript: false,
            clear: true,
          },
        },
      },
    });

    test("c-selection-workers: a slot switch reaches dedicated and shared workers", async ({
      strict,
    }) => {
      const lab = await labOf(strict);
      const { before, after } = SWITCH_SLOTS;
      const samples = (await repeat(SWITCH_SAMPLES, () => switchSample(lab, before, after))).flat();
      const outcomes = samples.map(evaluateSwitch);
      const verdict = e8Verdict("c-selection-workers", outcomes, browserOf(strict), SWITCH_KINDS);
      await finish(verdict, samples, SWITCH_SAMPLES * 2);
    });
  });
});
