import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";
import { closeTab, delayStep, incognitoWindows, journalOf } from "./fixtures/identity.ts";
import type { StepTiming } from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { lifecycleDriver, lifecycleSetUp, marksOf, stepDurations } from "./fixtures/lifecycle.ts";
import { marked, readMarker, writeMarker } from "./fixtures/markers.ts";
import { holding, inspect, writeSentinels } from "./fixtures/sentinels.ts";
import { openIncognitoTab } from "./fixtures/tabs.ts";
import { spread } from "./fixtures/teardown-probe.ts";
import { APP } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** A → B → A → C → A rounds in one test; the recorded run sets `POC_REPEATS=10`. */
const ROUNDS = Number(process.env.POC_REPEATS ?? "1");

/** One opening: its wall time, the journal's step durations, and the bootstrap's own timings. */
interface Sample {
  label: string;
  ms: number;
  steps: Record<string, number>;
  timings: StepTiming[];
}

const summary = (samples: readonly Sample[]) => {
  const switches = samples.filter(({ steps }) => "capture" in steps);
  const steps = new Set(switches.flatMap(({ steps: each }) => Object.keys(each)));
  return {
    rounds: ROUNDS,
    openings: samples.length,
    wallMs: spread(switches.map(({ ms }) => ms)),
    stepMs: Object.fromEntries(
      [...steps].map((step) => [step, spread(switches.map(({ steps: each }) => each[step]))]),
    ),
  };
};

test("A → B → A → C → A keeps each identity's markers apart and the normal profile's sentinels", async ({
  context,
  serviceWorker,
}) => {
  test.setTimeout(60_000 + ROUNDS * 60_000);
  const run = `lifecycle-${Date.now()}`;
  const normal = await context.newPage();
  await writeSentinels(normal, APP, `tag=normal-${run}&run=${run}`);
  const sentinels = await inspect(normal, APP, run);
  expect(sentinels).toMatchObject(holding(`normal-${run}`, APP));
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  const last = new Map<string, string>();
  const samples: Sample[] = [];
  const visit = async (label: string, round: number) => {
    const started = Date.now();
    let result: unknown;
    const marks = await marksOf(serviceWorker, async () => {
      result = await identities.open(label);
    });
    const ms = Date.now() - started;
    const page = await next();
    expect(await readMarker(page), `${label} in round ${round}`).toEqual(
      marked(last.get(label) ?? null),
    );
    const value = `${label}:${round}`;
    await writeMarker(page, value);
    last.set(label, value);
    const timings = Array.isArray(result) ? (result as StepTiming[]) : [];
    samples.push({ label, ms, steps: stepDurations(marks), timings });
  };

  await visit("A", 0);
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const label of ["B", "A", "C", "A"]) await visit(label, round);
  }
  expect(await incognitoWindows(serviceWorker)).toBe(1);
  // Unchanged, so no marker of any identity reached the normal profile either.
  expect(await inspect(normal, APP, run)).toEqual(sentinels);
  await keep("lifecycle-rounds", summary(samples));
});

test("Suspend saves and closes the identity, and Resume brings it back", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next, tab } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await writeMarker(await next(), "A:1");
  await identities.suspend();
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "close", status: "done" });
  await expect(identities.suspend()).rejects.toThrow("No Incognito workspace is open");
  await identities.resume("A");
  expect(await readMarker(await next())).toEqual(marked("A:1"));
  await expect(identities.resume("A")).rejects.toThrow("This identity is open");
  expect(tab.page?.isClosed()).toBe(false);
});

test("two dashboards issuing commands at once: one runs, the other is refused as busy", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  const other = await lifecycleDriver(context, serviceWorker);
  await identities.open("A");
  await writeMarker(await next(), "A:1");
  await identities.open("B");
  await writeMarker(await next(), "B:1");
  const outcomes = await Promise.allSettled([
    identities.open("A"),
    other.command({ type: "workspace-switch", identityId: identities.idOf("A") }),
  ]);
  const refused = outcomes.filter((outcome) => outcome.status === "rejected");
  expect(outcomes.map(({ status }) => status).toSorted()).toEqual(["fulfilled", "rejected"]);
  expect(String(refused[0]?.reason)).toContain("RECnRun is busy with another Incognito workspace");
  expect(await readMarker(await next())).toEqual(marked("A:1"));
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});

test("an Incognito window opened beside the identity is its session, one opened after the capture stops the close", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next, tab } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await writeMarker(await next(), "A:1");
  await identities.open("B");
  await writeMarker(await next(), "B:1");

  await openIncognitoTab(serviceWorker, "about:blank");
  expect(await incognitoWindows(serviceWorker)).toBe(2);
  await identities.open("A");
  expect(await readMarker(await next())).toEqual(marked("A:1"));
  expect(await incognitoWindows(serviceWorker)).toBe(1);

  await delayStep(serviceWorker, "persist", 1_500);
  const switching = identities.open("B");
  await expect
    .poll(() => journalOf(serviceWorker))
    .toMatchObject({ step: "persist", status: "running" });
  const during = await openIncognitoTab(serviceWorker, "about:blank");
  await expect(switching).rejects.toThrow(
    "The capture is saved; an Incognito tab opened while it ran, so run the command again to save it too.",
  );
  expect(await journalOf(serviceWorker)).toMatchObject({ step: "close", status: "failed" });
  // A's windows stayed open and hold what they held, the one opened after the capture too.
  expect(tab.page?.isClosed()).toBe(false);
  expect(await incognitoWindows(serviceWorker)).toBe(2);
  if (tab.page) expect(await readMarker(tab.page)).toEqual(marked("A:1"));
  if (during === undefined) throw new Error("No Incognito tab opened after the capture.");
  await closeTab(serviceWorker, during);
  await delayStep(serviceWorker, "persist", 0);
  await identities.open("B");
  expect(await readMarker(await next())).toEqual(marked("B:1"));
});

const RECORDS = 10_000;

/** Writes `RECORDS` records of about 200 bytes each to IndexedDB `bulk`, in one transaction. */
const writeBulk = (page: Page) =>
  page.evaluate(async (count) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("bulk", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("records");
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("open failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      const store = tx.objectStore("records");
      for (let key = 1; key <= count; key += 1) {
        store.put({ key, text: `record-${key}-`.padEnd(200, "x") }, key);
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("aborted"));
    });
    db.close();
  }, RECORDS);

/** The bulk store's record count and its last record's key, read back in the page. */
const readBulk = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ count: number; last: unknown }>((resolve, reject) => {
        const opening = indexedDB.open("bulk");
        opening.onerror = () => reject(opening.error ?? new Error("open failed"));
        opening.onsuccess = () => {
          const store = opening.result.transaction("records").objectStore("records");
          const count = store.count();
          const last = store.get(10_000);
          last.onsuccess = () => {
            opening.result.close();
            const record = last.result as { key: unknown } | undefined;
            resolve({ count: count.result, last: record?.key ?? null });
          };
        };
      }),
  );

test("a 10,000-record database survives a switch away and back, with its size and timings", async ({
  context,
  serviceWorker,
}) => {
  const { driver, identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await writeBulk(await next());
  const away = await marksOf(serviceWorker, () => identities.open("B"));
  await next();
  let timings: unknown;
  const back = await marksOf(serviceWorker, async () => {
    timings = await identities.open("A");
  });
  expect(await readBulk(await next())).toEqual({ count: RECORDS, last: RECORDS });
  const status = (await driver.command({ type: "workspace-status" })) as {
    identities: { label: string; lastCapture?: { bytes: number } }[];
  };
  const bytes = status.identities.find(({ label }) => label === "A")?.lastCapture?.bytes;
  expect(bytes).toBeGreaterThan(RECORDS * 200);
  await keep("lifecycle-10k", {
    records: RECORDS,
    captureBytes: bytes,
    awayMs: stepDurations(away),
    backMs: stepDurations(back),
    restoreTimings: timings,
  });
});
