import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test as base } from "../browser/fixtures/extension.ts";
import type { LoadedExtension } from "../browser/fixtures/extension.ts";
import { createObserver, currentRunId, evidenceName } from "../browser/observer/observer.ts";
import type { Observer } from "../browser/observer/observer.ts";
import { redact } from "../browser/observer/redact.ts";
import { takeSnapshot } from "../browser/observer/storage.ts";
import type { OriginInventory } from "../browser/observer/storage.ts";
import { browserOf } from "./e1-aggregate.ts";
import { evaluateSample, summarize, unavailable } from "./e2-samples.ts";
import type { E2Sample, JournalEntry } from "./e2-samples.ts";
import { appendVerdict } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.1; docs/poc/namespace-sessions/experiments/E2.md reports them.
// The harness drives pages and reads results: every chrome.debugger call runs in the isolator.
const APP = "http://app.localhost:4600";
const API = "http://api.localhost:4601";
// Node does not resolve *.localhost everywhere, so the harness reaches the ledger on the loopback.
const CONTROL = "http://127.0.0.1:4601";
const ROUTE_A = "globalThis.recnrunRouteA";
const BLANK = "about:blank#recnrun-e2";
const SW_ITERATIONS = 20;
const WORKER_ITERATIONS = 10;
const REPORT_TIMEOUT_MS = 15_000;
const SERVICE_WORKERS: Record<string, string> = {
  classic: "/sw-main.js?variant=classic",
  module: "/sw-main.js?variant=module",
  imports: "/sw-imports.js?variant=imports",
  static: "/sw-static.js?variant=static",
  dynamic: "/sw-dynamic.js?variant=dynamic",
};
const NESTED =
  "the frozen fixture starts no worker from a worker (apps/fixture/public/app/worker.js, shared-worker.js)";
// Base 36 has no 32-hex run, which the evidence redaction would hash.
const RUN = Date.now().toString(36);

interface LedgerEntry {
  seq: number;
  origin: string;
  path: string;
  marker: string | null;
}

interface RouteAJournal {
  entries: (JournalEntry & { targetId: string })[];
  unattached: { targetId: string; type: string; url: string }[];
}

interface Run {
  extension: LoadedExtension;
  context: BrowserContext;
}

/** What one armed page load left: the ledger after its checkpoint, the journal, and the stores. */
interface Loaded {
  entries: LedgerEntry[];
  journal: RouteAJournal;
  inventory: OriginInventory | undefined;
  report: unknown;
}

type SampleBase = Pick<E2Sample, "hypothesis" | "variant" | "marker" | "script" | "store">;

const test = base.extend<{ observer: Observer }>({
  observer: async ({ extension }, use, testInfo) => {
    const [context] = extension.chrome.browser.contexts();
    if (!context) throw new Error("Chrome has no default browser context");
    const observer = createObserver({
      cdp: extension.chrome.cdp,
      page: context.pages()[0] ?? (await context.newPage()),
      runId: currentRunId(),
      name: evidenceName(testInfo),
      ...(extension.label ? { label: extension.label } : {}),
    });
    await observer.start();
    try {
      await use(observer);
    } finally {
      await observer.finish();
    }
  },
});

async function call<T>(extension: LoadedExtension, expression: string): Promise<T> {
  return (await extension.evaluateInBackground(`${ROUTE_A}.${expression}`)) as T;
}

async function control(path: string, method = "POST"): Promise<Response> {
  const response = await fetch(`${CONTROL}${path}`, { method });
  expect(response.ok, `${method} ${path}`).toBe(true);
  return response;
}

async function ledger(since = 0): Promise<LedgerEntry[]> {
  const entries = (await (await control("/__ledger", "GET")).json()) as LedgerEntry[];
  return entries.filter((entry) => entry.seq > since);
}

async function checkpoint(): Promise<number> {
  return (await ledger()).at(-1)?.seq ?? 0;
}

function pathOf(url: string): string {
  const parsed = new URL(url, APP);
  return parsed.pathname + parsed.search;
}

/** The `from` of a `/me?from=` request: the script of the worker that made it. */
function fromOf(path: string): string | null {
  return new URL(path, API).searchParams.get("from");
}

async function reportOf(page: Page, url: string): Promise<unknown> {
  await page.goto(url);
  const element = page.locator("#report[data-ready]");
  const ready = await element.waitFor({ timeout: REPORT_TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
  if (!ready) return { error: `no report within ${REPORT_TIMEOUT_MS} ms` };
  return JSON.parse((await element.textContent()) ?? "null") as unknown;
}

async function tabOf(extension: LoadedExtension, page: Page, blank: string): Promise<number> {
  await page.goto(blank);
  const tabs = await call<{ tabId: number; url: string }[]>(extension, "tabs()");
  const tab = tabs.find((candidate) => candidate.url === blank);
  if (!tab) throw new Error(`no tab at ${blank}: ${JSON.stringify(tabs)}`);
  return tab.tabId;
}

/** IndexedDB names the page's frame resolves for the app origin, so the session is the page's. */
async function inventoryOf(run: Run, page: Page, label: string) {
  const session = await run.context.newCDPSession(page);
  const sessions = { page: session, browser: run.extension.chrome.cdp };
  const snapshot = await takeSnapshot(sessions, [APP], label);
  await session.detach();
  return snapshot.origins[APP];
}

/** Shared workers still alive, which the next load would join instead of starting its own. */
async function sharedWorkersLeft(run: Run): Promise<string[]> {
  const { targetInfos } = await run.extension.chrome.cdp.send("Target.getTargets");
  return targetInfos
    .filter(({ type, url }) => type === "shared_worker" && url.startsWith(APP))
    .map(({ url }) => pathOf(url));
}

/** Arms a new tab with `marker`, loads `url`, and returns what the load left once it painted. */
async function load(run: Run, name: "sw" | "workers", url: string, marker: string) {
  // A navigation keeps the last page in the back/forward cache with its shared worker; a closed tab does not.
  const page = await run.context.newPage();
  const tab = `{ tabId: ${await tabOf(run.extension, page, `${BLANK}-${marker}`)} }`;
  await call(run.extension, `setMarker(${JSON.stringify(marker)})`);
  await call(run.extension, `arm(${tab})`);
  const since = await checkpoint();
  const report = await reportOf(page, url);
  // The page sends first-paint after it shows its report, once every worker answered.
  const painted = async () => (await ledger(since)).some((e) => e.marker === `${name}:first-paint`);
  await expect.poll(painted, { timeout: REPORT_TIMEOUT_MS }).toBe(true);
  const journal = await call<RouteAJournal>(run.extension, `disarm(${tab})`);
  const inventory = await inventoryOf(run, page, marker);
  const loaded: Loaded = { entries: await ledger(since), journal, inventory, report };
  await call(run.extension, `clearOrigin(${tab})`);
  await page.close();
  await expect.poll(() => sharedWorkersLeft(run), { timeout: REPORT_TIMEOUT_MS }).toEqual([]);
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
    await control("/__network?mode=online");
    await control("/__ledger/reset");
    // Headed Chrome holds pushManager.subscribe() on a permission prompt nobody answers; deny it instead.
    await extension.chrome.cdp.send("Browser.setPermission", {
      permission: { name: "notifications" },
      setting: "denied",
      origin: APP,
    });
    const run: Run = { extension, context: observer.page.context() };
    const evidence: unknown[] = [];
    const register = await serviceWorkerSamples(run, evidence);
    const { dedicated, shared } = await workerSamples(run, evidence);
    await observer.collectLedger(CONTROL);
    await mkdir(observer.directory, { recursive: true });
    await writeFile(
      join(observer.directory, "samples.json"),
      `${JSON.stringify(redact(evidence), null, 2)}\n`,
    );

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
