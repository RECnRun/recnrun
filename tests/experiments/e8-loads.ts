import type { LabJournal, StrictExtension } from "../browser/fixtures/strict-lab.ts";
import {
  APP,
  armHere,
  databaseOf,
  reloadedOrHeld,
  stopWorkers,
  visit,
} from "../browser/fixtures/strict-steps.ts";
import { press } from "../browser/fixtures/strict-ui.ts";
import type { E1Browser } from "./e1-aggregate.ts";
import type { Names } from "./e5-samples.ts";
import { errorOf, slotName } from "./e6-loads.ts";
import type { SwitchSample } from "./e6-samples.ts";
import { SW_SCRIPT } from "./e8-samples.ts";
import type { ColdSample } from "./e8-samples.ts";
import { checkpoint, fromOf, ledger } from "./page-loads.ts";

/*
 * E8's samples in the strict lab: every page is typed in a new tab of the Chrome window, every
 * command goes through the managed policy, and every answer comes from the posted journal or the
 * fixture's ledger. No CDP client exists, so nothing else resumes a worker the isolator holds.
 */

const WORKERS = `${APP}/workers.html?type=classic`;
const SELECT_TIMEOUT_MS = 15_000;

export interface Lab {
  strict: StrictExtension;
  window: string;
}

export const browserOf = (strict: StrictExtension): E1Browser => ({
  chrome: strict.chrome.version,
  method: strict.method,
});

/** A new tab the lab armed (and cleared, as every E8 arm asks). */
async function armedTab({ strict, window }: Lab) {
  await press(window, "ctrl+t");
  return armHere(strict, window);
}

/** Closes the current tab, which ends its shared worker, then stops what still runs. */
async function closeTab({ strict, window }: Lab): Promise<void> {
  await press(window, "ctrl+w");
  await stopWorkers(strict);
}

function pauseOf(journal: LabJournal | undefined, marker: string): boolean | undefined {
  const entries = journal?.routeA.entries ?? [];
  const own = entries.filter((e) => e.marker === marker && e.type === "service_worker");
  return own.at(-1)?.pause?.paused;
}

/** One cold registration of the classic worker in an armed, cleared tab (E3's before-script-execution). */
export async function coldSample(lab: Lab): Promise<ColdSample> {
  const tab = await armedTab(lab);
  const since = await checkpoint();
  const page = await visit(tab);
  const effects = (await ledger(since))
    .filter((entry) => fromOf(entry.path) === SW_SCRIPT)
    .map((entry) => entry.path);
  const paused = pauseOf(lab.strict.sink.journal, tab.marker);
  await closeTab(lab);
  const { marker } = tab;
  const database = databaseOf(page);
  return {
    marker,
    effects,
    database,
    databases: page.indexedDB,
    caches: page.cacheStorage,
    paused,
  };
}

/** A marked registration, the lab's closeTarget, then a reload typed in the omnibox (E3's cold start). */
export async function restartSample(lab: Lab) {
  const tab = await armedTab(lab);
  const registered = databaseOf(await visit(tab));
  await stopWorkers(lab.strict);
  const restarted = await reloadedOrHeld(tab);
  await closeTab(lab);
  return { marker: tab.marker, registered, restarted };
}

/** Points the selection at `slot` and waits until the lab applied it; returns its update time. */
async function select(strict: StrictExtension, slot: number): Promise<number> {
  const own = (journal: LabJournal | undefined) =>
    (journal?.commands ?? []).filter(({ key }) => key.startsWith(`select:{"slot":${slot},`));
  const before = own(strict.sink.journal).length;
  await strict.setLab({ selection: { slot, origins: [APP] } });
  const applied = (journal: LabJournal) => own(journal).length > before;
  const journal = await strict.sink.until(
    applied,
    `the lab to select slot ${slot}`,
    SELECT_TIMEOUT_MS,
  );
  const result = own(journal).at(-1)?.result as { updateMs?: number; error?: string } | undefined;
  if (result?.updateMs === undefined) throw new Error(`select ${slot}: ${JSON.stringify(result)}`);
  return result.updateMs;
}

async function workersLoad(lab: Lab): Promise<{ report: unknown; names: Names }> {
  const page = await visit(await armedTab(lab), WORKERS);
  await closeTab(lab);
  return {
    report: page.report ? (JSON.parse(page.report) as unknown) : null,
    names: page.indexedDB,
  };
}

const STARTED_ERRORS = /failed to start|no report/;

/** E6's c-workers: a dedicated and a shared worker under slot `before`, the switch, and both again. */
export async function switchSample(
  lab: Lab,
  before: number,
  after: number,
): Promise<SwitchSample[]> {
  await select(lab.strict, before);
  const first = await workersLoad(lab);
  const switchMs = await select(lab.strict, after);
  const second = await workersLoad(lab);
  return (["dedicated", "shared"] as const).map((realm) => {
    const error = errorOf(first.report, realm);
    return {
      realm,
      selection: "sync-xhr",
      timing: "late",
      before: slotName(before),
      after: slotName(after),
      store: `fixture-${realm}`,
      first: first.names,
      second: second.names,
      started: !STARTED_ERRORS.test(errorOf(second.report, realm) ?? ""),
      ...(error === undefined ? {} : { error }),
      switchMs,
    };
  });
}
