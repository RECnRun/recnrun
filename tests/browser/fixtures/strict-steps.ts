import type { LabJournal, LabPage, LabSettings, StrictExtension } from "./strict-lab.ts";
import { navigate, press } from "./strict-ui.ts";

/*
 * Steps of the strict lab (E8) on the fixture's app: each one is typed in the window or written
 * to the policy, and each answer is read from the journal the isolator posts.
 */

export const APP = "http://app.localhost:4600";
const SW_PAGE = `${APP}/sw.html?sw=classic`;
// A static page of the origin: the lab arms the tab there, before any script of the app runs.
const OFFLINE = `${APP}/offline.html`;
const PAGE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const HOLD_MS = 10_000;
let commands = 0;

export interface StrictTab {
  strict: StrictExtension;
  window: string;
  tabId: number;
  marker: string;
}

/** The IndexedDB name the fixture's service worker reported on the page. */
export function databaseOf(page: LabPage | undefined): unknown {
  const report = page?.report ? (JSON.parse(page.report) as unknown) : undefined;
  return (report as { worker?: { database?: unknown } } | undefined)?.worker?.database;
}

const journalOf = (strict: StrictExtension): LabJournal | undefined => strict.sink.journal;

/** Goes to the static page in the window's current tab and waits until the lab armed that tab. */
export async function armHere(strict: StrictExtension, window: string): Promise<StrictTab> {
  const before = journalOf(strict)?.armed.length ?? 0;
  await navigate(window, OFFLINE);
  const journal = await strict.sink.until((j) => j.armed.length > before, "the lab to arm a tab");
  const armed = journal.armed.at(-1);
  if (armed === undefined || armed.error !== undefined) {
    throw new Error(`the lab did not arm the tab: ${JSON.stringify(armed)}`);
  }
  return { strict, window, tabId: armed.tabId, marker: armed.marker };
}

/** Goes to `url` in the window's current tab and returns what the lab read on the page. */
export async function visit(tab: StrictTab, url = SW_PAGE, ms = PAGE_TIMEOUT_MS): Promise<LabPage> {
  const before = journalOf(tab.strict)?.pages.length ?? 0;
  await navigate(tab.window, url);
  const check = (journal: LabJournal) => journal.pages.length > before;
  const journal = await tab.strict.sink.until(check, `the lab to read ${url}`, ms);
  return journal.pages.at(-1) as LabPage;
}

const reloaded = async (tab: StrictTab): Promise<unknown> => databaseOf(await visit(tab));

/** What a reload answers when its page does not load: its service worker waits on a debugger. */
const HELD = "held";

/** The database after a reload, or HELD, with the load stopped, when the page shows no report in 10 s. */
export async function reloadedOrHeld(tab: StrictTab): Promise<unknown> {
  try {
    return databaseOf(await visit(tab, SW_PAGE, HOLD_MS));
  } catch {
    await press(tab.window, "Escape");
    return HELD;
  }
}

/** Writes one command to the policy and returns its result once the journal records it. */
async function command(
  strict: StrictExtension,
  name: "stop" | "clear",
  request: Record<string, unknown>,
): Promise<unknown> {
  const id = `c${++commands}`;
  await strict.setLab({ [name]: { id, ...request } } as LabSettings);
  const key = `${name}:${id}`;
  const has = (journal: LabJournal) => journal.commands.some((entry) => entry.key === key);
  const journal = await strict.sink.until(has, `the lab's ${key}`, PAGE_TIMEOUT_MS);
  return journal.commands.find((entry) => entry.key === key)?.result;
}

const appWorkers = (journal: LabJournal, origin: string) =>
  journal.targets.filter(({ type, url }) => type === "worker" && url.startsWith(`${origin}/`));

/** Stops the origin's workers through the lab's `closeTarget`, again when one still runs after 5 s. */
export async function stopWorkers(strict: StrictExtension, origin = APP): Promise<void> {
  for (let tries = 5; tries > 0; tries--) {
    await command(strict, "stop", { origin });
    const gone = (journal: LabJournal) => appWorkers(journal, origin).length === 0;
    const stopped = await strict.sink.until(gone, "the workers to stop", STOP_TIMEOUT_MS).then(
      () => true,
      () => false,
    );
    if (stopped) return;
  }
  throw new Error(`a worker of ${origin} still ran after five stops`);
}

/**
 * E3's next starts: the database after the lab stops the worker and the page reloads, then after
 * the tab's origin is cleared so the page registers a new worker.
 */
export async function nextStarts(
  tab: StrictTab,
): Promise<{ restarted: unknown; registered: unknown }> {
  await stopWorkers(tab.strict);
  const restarted = await reloadedOrHeld(tab);
  await command(tab.strict, "clear", { tabId: tab.tabId });
  await stopWorkers(tab.strict);
  return { restarted, registered: await reloaded(tab) };
}

/** The devtools:// targets `chrome.debugger.getTargets()` lists in the last journal. */
export function devtoolsTargets(strict: StrictExtension): string[] {
  const targets = journalOf(strict)?.targets ?? [];
  return targets.filter(({ url }) => url.startsWith("devtools://")).map(({ url }) => url);
}
