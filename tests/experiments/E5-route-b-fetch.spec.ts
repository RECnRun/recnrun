import { expect } from "../browser/fixtures/extension.ts";
import { browserOf } from "./e1-aggregate.ts";
import { addressSample, capabilitiesOf, firstSample, importSample } from "./e5-build.ts";
import { offlineSample, updateSample } from "./e5-build.ts";
import { CLASSIC, PATTERN, loadFirst, loadOffline, loadUpdate } from "./e5-loads.ts";
import type { ArmOptions } from "./e5-loads.ts";
import {
  evaluateAddress,
  evaluateOffline,
  evaluateTabSession,
  evaluateUpdate,
} from "./e5-paths.ts";
import type { AddressSample, OfflineSample, UpdateSample } from "./e5-paths.ts";
import { evaluateFirst, evaluateImports, verdictOf } from "./e5-samples.ts";
import type { FirstSample, ImportSample, RouteBJournal } from "./e5-samples.ts";
import { CONTROL, prepareFixture, test, writeSamples } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { sized } from "./samples.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.4; docs/poc/namespace-sessions/experiments/E5.md reports them.
// The harness drives pages and reads results: every Fetch.*, Target.*, and Runtime.* call runs in the isolator.
const FIRST_ITERATIONS = sized(20);
const PATH_ITERATIONS = sized(10);
const DIAGNOSTIC_ITERATIONS = sized(5);
const SERVICE_WORKERS: Record<string, string> = {
  classic: CLASSIC,
  module: "/sw-main.js?variant=module",
  imports: "/sw-imports.js?variant=imports",
  static: "/sw-static.js?variant=static",
  dynamic: "/sw-dynamic.js?variant=dynamic",
};
// What apps/fixture/public/app/sw-imports.js and sw-static.js import.
const IMPORTED = [
  {
    variant: "imports",
    script: "/sw-imports.js?variant=imports",
    imports: ["/sw-main.js", "/sw-imported.js"],
  },
  { variant: "static", script: "/sw-static.js?variant=static", imports: ["/sw-main.js"] },
];
const STORES = [
  "storeUnprefixed:IndexedDB",
  "storeUnprefixed:CacheStorage",
  "storeMissing",
  "storeUnreadable",
];
const EFFECTS = ["noEffect", "firstEffectBeforeMarker", "unmarkedEffect"];
const FIRST_KINDS = ["notIntercepted", "notTransformed", "notReleased", ...EFFECTS, ...STORES];
const UPDATE_KINDS = [
  "updateFailed",
  "newVersionInstalled",
  "noNewVersion",
  "notIntercepted",
  "notTransformed",
];
const OFFLINE_KINDS = ["notStopped", "notTransformed", "notServedOffline", ...EFFECTS, ...STORES];
// Base 36 has no 32-hex run, which the evidence redaction would hash.
const RUN = Date.now().toString(36);

const markerFor = (name: string, iteration: number) => `e5-${name}-${iteration}-${RUN}`;

/** Every service-worker variant registered once per iteration from a new armed tab. */
async function firstSamples(run: Run, evidence: unknown[]): Promise<FirstSample[]> {
  const samples: FirstSample[] = [];
  for (let iteration = 0; iteration < FIRST_ITERATIONS; iteration += 1) {
    for (const [variant, script] of Object.entries(SERVICE_WORKERS)) {
      const marker = markerFor(variant, iteration);
      const loaded = await loadFirst(run, variant, marker);
      const sample = firstSample(variant, script, marker, loaded);
      samples.push(sample);
      evidence.push({
        path: "first",
        sample,
        outcome: evaluateFirst(sample),
        report: loaded.report,
      });
    }
  }
  return samples;
}

/** The importing variants armed to fulfill their imported scripts wrapped too. */
async function transformSamples(run: Run, evidence: unknown[]): Promise<ImportSample[]> {
  const samples: ImportSample[] = [];
  for (let iteration = 0; iteration < DIAGNOSTIC_ITERATIONS; iteration += 1) {
    for (const { variant, script, imports } of IMPORTED) {
      const marker = markerFor(`${variant}-t`, iteration);
      const loaded = await loadFirst(run, variant, marker, { imports: "transform" });
      const sample = importSample(firstSample(variant, script, marker, loaded), imports, true);
      samples.push(sample);
      evidence.push({ path: "imports-transform", sample, outcome: evaluateImports(sample) });
    }
  }
  return samples;
}

/** registration.update() with the marker of the running version, then with another. */
async function updateSamples(run: Run, evidence: unknown[]): Promise<UpdateSample[]> {
  const samples: UpdateSample[] = [];
  for (let iteration = 0; iteration < PATH_ITERATIONS; iteration += 1) {
    for (const variant of ["same-marker", "new-marker"] as const) {
      const marker = markerFor(`u-${variant}`, iteration);
      const next = variant === "same-marker" ? marker : `${marker}-next`;
      const updated = await loadUpdate(run, marker, next);
      const sample = updateSample(variant, next, updated);
      samples.push(sample);
      const { outcome, report } = { outcome: evaluateUpdate(sample), report: updated.first.report };
      evidence.push({ path: "update", sample, outcome, first: updated.first.journal, report });
    }
  }
  return samples;
}

/** A first load, the worker stopped, and a restart under the scope with the network cut. */
async function offlineSamples(run: Run, evidence: unknown[]): Promise<OfflineSample[]> {
  const samples: OfflineSample[] = [];
  for (let iteration = 0; iteration < PATH_ITERATIONS; iteration += 1) {
    const marker = markerFor("offline", iteration);
    const restart = { network: true };
    const restarted = await loadOffline(run, marker, `${marker}-r`, { restart });
    const sample = offlineSample(marker, restarted);
    samples.push(sample);
    const { stopped, journal, entries } = restarted;
    evidence.push({
      path: "offline",
      sample,
      outcome: evaluateOffline(sample),
      stopped,
      journal,
      entries,
    });
  }
  return samples;
}

/** Network events of a fulfilled worker against a worker whose script Route B left alone. */
async function addressSamples(run: Run, evidence: unknown[]): Promise<AddressSample[]> {
  const samples: AddressSample[] = [];
  const options: Record<AddressSample["variant"], ArmOptions> = {
    fulfilled: { network: true },
    control: { network: true, workerFetch: false },
  };
  for (let iteration = 0; iteration < DIAGNOSTIC_ITERATIONS; iteration += 1) {
    for (const variant of ["fulfilled", "control"] as const) {
      const marker = markerFor(`a-${variant}`, iteration);
      const loaded = await loadFirst(run, "classic", marker, options[variant]);
      const sample = addressSample(variant, loaded);
      samples.push(sample);
      evidence.push({
        path: "address",
        sample,
        outcome: evaluateAddress(sample),
        report: loaded.report,
      });
    }
  }
  return samples;
}

/** First registrations armed with the pattern `*`, so nothing the tab fetches escapes it. */
async function starJournals(run: Run, evidence: unknown[]): Promise<RouteBJournal[]> {
  const journals: RouteBJournal[] = [];
  for (let iteration = 0; iteration < DIAGNOSTIC_ITERATIONS; iteration += 1) {
    const loaded = await loadFirst(run, "classic", markerFor("star", iteration), {
      urlPattern: "*",
    });
    journals.push(loaded.journal);
    evidence.push({ path: "tab-session", journal: loaded.journal });
  }
  return journals;
}

test.describe("E5: Route B transforms service-worker scripts through Fetch", () => {
  test.describe.configure({ timeout: 1_800_000 });

  test("every hypothesis runs its iterations and gets a verdict", async ({
    extension,
    observer,
  }) => {
    await prepareFixture(extension);
    const run: Run = { extension, context: observer.page.context() };
    const evidence: unknown[] = [];
    const first = await firstSamples(run, evidence);
    const imports = IMPORTED.flatMap(({ variant, imports: paths }) =>
      first
        .filter((sample) => sample.variant === variant)
        .map((s) => importSample(s, paths, false)),
    );
    const transformed = await transformSamples(run, evidence);
    const updates = await updateSamples(run, evidence);
    const offline = await offlineSamples(run, evidence);
    const addresses = await addressSamples(run, evidence);
    const star = await starJournals(run, evidence);
    await observer.collectLedger(CONTROL);
    await writeSamples(observer.directory, evidence);

    const browser = browserOf(extension);
    const tabSession = [
      ...first.map((s) =>
        evaluateTabSession({ variant: PATTERN, script: s.script, journal: s.journal }),
      ),
      ...star.map((journal) => evaluateTabSession({ variant: "*", script: CLASSIC, journal })),
    ];
    const diagnostic = { label: "diagnostic" as const };
    const verdicts = [
      verdictOf("first", first.map(evaluateFirst), browser, { kinds: FIRST_KINDS }),
      verdictOf("imports", imports.map(evaluateImports), browser, {
        kinds: ["importNotIntercepted"],
      }),
      verdictOf("update", updates.map(evaluateUpdate), browser, { kinds: UPDATE_KINDS }),
      verdictOf("offline", offline.map(evaluateOffline), browser, { kinds: OFFLINE_KINDS }),
      verdictOf("imports-transform", transformed.map(evaluateImports), browser, {
        kinds: ["importNotIntercepted", "importNotTransformed"],
        ...diagnostic,
      }),
      verdictOf("tab-session-main-script", tabSession, browser, {
        kinds: ["notOnTabSession"],
        ...diagnostic,
      }),
      verdictOf("fulfilled-worker-address-space", addresses.map(evaluateAddress), browser, {
        kinds: ["addressSpace", "blocked"],
        ...diagnostic,
      }),
    ];
    for (const verdict of verdicts) await appendVerdict(verdict);
    await mergeCapabilities({
      routeB: capabilitiesOf({ first, imports, updates, addresses, star }),
    });
    console.log(JSON.stringify(verdicts, null, 2));

    const variants = Object.keys(SERVICE_WORKERS).length;
    expect(verdicts.map(({ hypothesis, samples }) => [hypothesis, samples])).toEqual([
      ["first", FIRST_ITERATIONS * variants],
      ["imports", FIRST_ITERATIONS * IMPORTED.length],
      ["update", PATH_ITERATIONS * 2],
      ["offline", PATH_ITERATIONS],
      ["imports-transform", DIAGNOSTIC_ITERATIONS * IMPORTED.length],
      ["tab-session-main-script", FIRST_ITERATIONS * variants + DIAGNOSTIC_ITERATIONS],
      ["fulfilled-worker-address-space", DIAGNOSTIC_ITERATIONS * 2],
    ]);
    for (const verdict of verdicts) {
      if (verdict.verdict === "pass")
        expect(verdict.counts?.passed, verdict.hypothesis).toBe(verdict.samples);
    }
  });
});
