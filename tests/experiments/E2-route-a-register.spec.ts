import type { OriginInventory } from "../browser/observer/storage.ts";
import { browserOf } from "./e1-aggregate.ts";
import { evaluateSample, summarize, unavailable } from "./e2-samples.ts";
import type { E2Sample, JournalEntry } from "./e2-samples.ts";
import {
  API,
  APP,
  CONTROL,
  SERVICE_WORKERS,
  call,
  checkpoint,
  closeAndSettle,
  expect,
  fromOf,
  inventoryOf,
  ledger,
  markerSeen,
  pathOf,
  prepareFixture,
  reportOf,
  tabOf,
  test,
  writeSamples,
} from "./page-loads.ts";
import type { LedgerEntry, Run } from "./page-loads.ts";
import { appendVerdict } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.1; docs/poc/namespace-sessions/experiments/E2.md reports them.
// The harness drives pages and reads results: every chrome.debugger call runs in the isolator.
const BLANK = "about:blank#recnrun-e2";
const SW_ITERATIONS = 20;
const WORKER_ITERATIONS = 10;
const NESTED =
  "the frozen fixture starts no worker from a worker (apps/fixture/public/app/worker.js, shared-worker.js)";
// Base 36 has no 32-hex run, which the evidence redaction would hash.
const RUN = Date.now().toString(36);

interface RouteAJournal {
  entries: (JournalEntry & { targetId: string })[];
  unattached: { targetId: string; type: string; url: string }[];
}

/** What one armed page load left: the ledger after its checkpoint, the journal, and the stores. */
interface Loaded {
  entries: LedgerEntry[];
  journal: RouteAJournal;
  inventory: OriginInventory | undefined;
  report: unknown;
}

type SampleBase = Pick<E2Sample, "hypothesis" | "variant" | "marker" | "script" | "store">;

/** Arms a new tab with `marker`, loads `url`, and returns what the load left once it painted. */
async function load(run: Run, name: "sw" | "workers", url: string, marker: string) {
  const page = await run.context.newPage();
  const tab = `{ tabId: ${await tabOf(run.extension, page, `${BLANK}-${marker}`)} }`;
  await call(run.extension, `setMarker(${JSON.stringify(marker)})`);
  await call(run.extension, `arm(${tab})`);
  const since = await checkpoint();
  const report = await reportOf(page, url);
  // The page sends first-paint after it shows its report, once every worker answered.
  await markerSeen(since, `${name}:first-paint`);
  const journal = await call<RouteAJournal>(run.extension, `disarm(${tab})`);
  const inventory = await inventoryOf(run, page, marker);
  const loaded: Loaded = { entries: await ledger(since), journal, inventory, report };
  await call(run.extension, `clearOrigin(${tab})`);
  await closeAndSettle(run, page);
  return loaded;
}

function sampleOf(
  loaded: Loaded,
  sample: SampleBase,
  isEffect = (entry: LedgerEntry) => fromOf(entry.path) === sample.script,
): E2Sample {
  const entry = loaded.journal.entries.find((item) => pathOf(item.url) === sample.script);
  const missing = { error: "no inventory of the app origin" };
  return {
    ...sample,
    effects: loaded.entries.filter(isEffect).map((item) => item.path),
    databases: loaded.inventory?.indexedDB ?? missing,
    caches: loaded.inventory?.cacheStorage ?? missing,
    ...(entry ? { entry } : {}),
  };
}

function markerFor(name: string, iteration: number): string {
  return `e2-${name}-${iteration}-${RUN}`;
}

function evidenceOf(sample: E2Sample, { journal, report }: Loaded) {
  return { sample, outcome: evaluateSample(sample), unattached: journal.unattached, report };
}

/** Every service-worker variant once per iteration; every request to the API is the worker's. */
async function serviceWorkerSamples(run: Run, evidence: unknown[]): Promise<E2Sample[]> {
  const samples: E2Sample[] = [];
  for (let iteration = 0; iteration < SW_ITERATIONS; iteration += 1) {
    for (const [variant, script] of Object.entries(SERVICE_WORKERS)) {
      const marker = markerFor(`sw-${variant}`, iteration);
      const loaded = await load(run, "sw", `${APP}/sw.html?sw=${variant}`, marker);
      const base = { hypothesis: "service-worker-register", variant, marker, script };
      const sample = sampleOf(loaded, { ...base, store: "fixture-sw" }, (e) => e.origin === API);
      samples.push(sample);
      evidence.push(evidenceOf(sample, loaded));
    }
  }
  return samples;
}

/** The dedicated and the shared worker of `workers.html`, classic and module in turn. */
async function workerSamples(run: Run, evidence: unknown[]) {
  const dedicated: E2Sample[] = [];
  const shared: E2Sample[] = [];
  for (let iteration = 0; iteration < WORKER_ITERATIONS; iteration += 1) {
    const variant = iteration % 2 === 0 ? "classic" : "module";
    const marker = markerFor(`workers-${variant}`, iteration);
    const loaded = await load(run, "workers", `${APP}/workers.html?type=${variant}`, marker);
    const base = { variant, marker };
    const pair = [
      sampleOf(loaded, {
        ...base,
        hypothesis: "dedicated-worker",
        script: `/worker.js?type=${variant}`,
        store: "fixture-dedicated",
      }),
      sampleOf(loaded, {
        ...base,
        hypothesis: "shared-worker",
        script: `/shared-worker.js?type=${variant}`,
        store: "fixture-shared",
      }),
    ] as const;
    dedicated.push(pair[0]);
    shared.push(pair[1]);
    for (const sample of pair) evidence.push(evidenceOf(sample, loaded));
  }
  return { dedicated, shared };
}

test.describe("E2: Route A bootstraps workers the page starts, before their first statement", () => {
  test.describe.configure({ timeout: 900_000 });

  test("every hypothesis runs its iterations and gets a verdict", async ({
    extension,
    observer,
  }) => {
    await prepareFixture(extension);
    const run: Run = { extension, context: observer.page.context() };
    const evidence: unknown[] = [];
    const register = await serviceWorkerSamples(run, evidence);
    const { dedicated, shared } = await workerSamples(run, evidence);
    await observer.collectLedger(CONTROL);
    await writeSamples(observer.directory, evidence);

    const browser = browserOf(extension);
    const verdicts = [
      summarize("service-worker-register", register, browser),
      summarize("dedicated-worker", dedicated, browser),
      summarize("shared-worker", shared, browser),
      unavailable("nested-worker", NESTED, browser),
    ];
    for (const verdict of verdicts) await appendVerdict(verdict);
    console.log(JSON.stringify(verdicts, null, 2));

    expect(verdicts.map(({ hypothesis, samples }) => [hypothesis, samples])).toEqual([
      ["service-worker-register", SW_ITERATIONS * Object.keys(SERVICE_WORKERS).length],
      ["dedicated-worker", WORKER_ITERATIONS],
      ["shared-worker", WORKER_ITERATIONS],
      ["nested-worker", 0],
    ]);
    for (const verdict of verdicts.slice(0, 3)) {
      expect(typeof verdict.counts?.firstEffectBeforeMarker, verdict.hypothesis).toBe("number");
      if (verdict.verdict === "pass") expect(verdict.counts?.passed).toBe(verdict.samples);
    }
  });
});
