import { expect } from "../browser/fixtures/extension.ts";
import type { LoadedExtension } from "../browser/fixtures/extension.ts";
import type { Observer } from "../browser/observer/observer.ts";
import { browserOf } from "./e1-aggregate.ts";
import {
  COLD_LOADS,
  DEDICATED_LOADS,
  DEDICATED_TYPES,
  SW_LOADS,
  coldSamples,
  evidenceOf,
  freshSamples,
} from "./e3-cases.ts";
import { CONDITION, setMarker } from "./e3-loads.ts";
import {
  RUNNING_SAMPLES,
  WAKE_SAMPLES,
  WAKE_TIMEOUT_MS,
  runningSamples,
  wakeSamples,
} from "./e3-running.ts";
import type { Wake } from "./e3-running.ts";
import { capabilityOf, summarize, unavailable } from "./e3-samples.ts";
import type { Context } from "./e3-samples.ts";
import { CONTROL, SERVICE_WORKERS, prepareFixture, test, writeSamples } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";
import type { Verdict } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.2; docs/poc/namespace-sessions/experiments/E3.md reports them.
// The harness drives pages and reads results: every chrome.debugger call runs in the isolator.
const VARIANTS = Object.keys(SERVICE_WORKERS).length;
const FRESH = SW_LOADS * VARIANTS + DEDICATED_LOADS * DEDICATED_TYPES.length;
const BREAKPOINT = "Debugger.setInstrumentationBreakpoint";

/** A clean fixture and a placeholder marker, which a switch-late run arms with. */
async function start(extension: LoadedExtension, observer: Observer) {
  await prepareFixture(extension);
  const run: Run = { extension, context: observer.page.context() };
  await setMarker(run, "e3-placeholder");
  const context: Context = { browser: browserOf(extension), condition: CONDITION };
  return { run, context };
}

async function finish(observer: Observer, evidence: unknown[], verdict: Verdict): Promise<void> {
  await observer.collectLedger(CONTROL);
  await writeSamples(observer.directory, evidence);
  await appendVerdict(verdict);
  console.log(JSON.stringify(verdict, null, 2));
}

function checked(verdict: Verdict, samples: number): void {
  expect([verdict.samples, verdict.condition], verdict.hypothesis).toEqual([samples, CONDITION]);
  expect(typeof verdict.lateAttaches, verdict.hypothesis).toBe("number");
  if (verdict.verdict === "pass") expect(verdict.counts?.passed).toBe(verdict.samples);
}

function wakeVerdict(wakes: Wake[], context: Context): Verdict {
  const count = (pick: (wake: Wake) => boolean) => wakes.filter(pick).length;
  const counts = {
    samples: wakes.length,
    woke: count((wake) => wake.woke),
    syncAtRegistration: count((wake) => wake.syncAtRegistration),
    stopped: count((wake) => wake.stop.stopped),
    lateAttaches: 0,
  };
  const error =
    `no worker woke within ${WAKE_TIMEOUT_MS} ms of /__network offline then online, in ` +
    `${counts.samples} of ${counts.samples} tries; fixture-sync had already fired while the ` +
    `registering page was open in ${counts.syncAtRegistration} of ${counts.samples}, and the ` +
    "harness cannot take the browser offline (context.setOffline and Network.emulateNetworkConditions " +
    "are outside its allowlist), so no sync stays pending; push is out of reach: the harness may " +
    "only deny the notification permission, so pushManager.subscribe() fails with NotAllowedError";
  return unavailable("wake-without-tab", error, context, counts);
}

// Trace snapshots read every response body; Network.getResponseBody on a navigation preload closed Chrome.
test.use({ trace: { mode: "retain-on-failure", snapshots: false } });

test.describe("E3: Route A reaches workers before their first statement, cold and racing", () => {
  test.describe.configure({ timeout: 2_400_000 });

  test("before-script-execution: an armed tab bootstraps each worker at its first pause @order-critical", async ({
    extension,
    observer,
  }) => {
    const { run, context } = await start(extension, observer);
    const evidence: unknown[] = [];
    const samples = await freshSamples(run, "before-script-execution", "pause", evidence);
    const results = samples.flatMap(({ entry }) =>
      (entry?.pause?.steps ?? []).filter(({ step }) => step === BREAKPOINT).map((s) => s.result),
    );
    const description = `${BREAKPOINT}({ instrumentation: "beforeScriptExecution" }) on a worker the tab's auto-attach holds`;
    await mergeCapabilities({
      debugger: {
        "worker-instrumentation-breakpoint": capabilityOf(description, results, extension.method),
      },
    });
    const verdict = summarize("before-script-execution", samples, context);
    await finish(observer, evidence, verdict);
    checked(verdict, FRESH);
  });

  test("direct-attach-race: watch attaches each new worker by id as it appears @order-critical", async ({
    extension,
    observer,
  }) => {
    const { run, context } = await start(extension, observer);
    const evidence: unknown[] = [];
    const samples = await freshSamples(run, "direct-attach-race", "watch", evidence);
    const verdict = summarize("direct-attach-race", samples, context);
    await finish(observer, evidence, verdict);
    checked(verdict, FRESH);
  });

  test("cold-start-navigation: a navigation restarts a worker the isolator stopped @order-critical", async ({
    extension,
    observer,
  }) => {
    const { run, context } = await start(extension, observer);
    const evidence: unknown[] = [];
    const { samples, closes } = await coldSamples(run, evidence);
    const description =
      "Target.closeTarget on a service worker, sent on its own session, to cold-start it";
    const results = closes.map(({ close }) => close);
    await mergeCapabilities({
      debugger: {
        "worker-close-target-cold-start": capabilityOf(description, results, extension.method),
      },
    });
    const verdict = summarize("cold-start-navigation", samples, context);
    await finish(observer, evidence, verdict);
    checked(verdict, 2 * COLD_LOADS * VARIANTS);
  });

  test("pre-existing-running: a worker already running is reached late @order-critical", async ({
    extension,
    observer,
  }) => {
    const { run, context } = await start(extension, observer);
    const results = await runningSamples(run);
    const evidence = results.map(({ loaded, sample, cleanup }) =>
      evidenceOf(sample, loaded, { cleanup }),
    );
    const verdict = summarize(
      "pre-existing-running",
      results.map(({ sample }) => sample),
      context,
    );
    await finish(observer, evidence, verdict);
    checked(verdict, RUNNING_SAMPLES);
    // Route A meets this worker after its first statements by construction: never a pass.
    expect(verdict.verdict).toBe("fail");
  });

  test("wake-without-tab: a worker woken with no tab open is attached by watch @order-critical", async ({
    extension,
    observer,
  }) => {
    const { run, context } = await start(extension, observer);
    const results = await wakeSamples(run);
    const evidence = results.map(({ loaded, sample, wake }) => ({
      ...evidenceOf(sample, loaded),
      wake,
    }));
    const woken = results.filter(({ wake }) => wake.woke).map(({ sample }) => sample);
    const verdict =
      woken.length === 0
        ? wakeVerdict(
            results.map(({ wake }) => wake),
            context,
          )
        : summarize("wake-without-tab", woken, context);
    await finish(observer, evidence, verdict);
    checked(verdict, woken.length === 0 ? WAKE_SAMPLES : woken.length);
  });
});
