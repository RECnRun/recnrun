import type { BrowserContext, Page, Worker } from "@playwright/test";
import { BLANK } from "./captures.ts";
import { expect } from "./extension.ts";

/** A background reply, as `BackgroundReplySchema` shapes it. */
type Reply = { ok: true; result?: unknown } | { ok: false; error: string };

/** One journal write the service worker saw, timed by its own clock. */
export interface JournalMark {
  id: string;
  kind: string;
  step: string;
  status: string;
  at: number;
}

interface ChromeGlobal {
  chrome: {
    runtime: { sendMessage: (message: unknown) => Promise<Reply> };
    storage: {
      onChanged: {
        addListener: (
          listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void,
        ) => void;
      };
    };
  };
  __journalMarks?: JournalMark[];
}

/** The dashboard as a page of its own in a normal tab: the background answers it as its own page. */
export async function lifecycleDriver(context: BrowserContext, serviceWorker: Worker) {
  const page: Page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(serviceWorker.url()).host}/dashboard.html`);
  const send = (message: object) =>
    page.evaluate(
      (sent) => (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage(sent),
      message,
    );
  /** Sends `message` and resolves with its result, or rejects with the background's refusal. */
  const command = async (message: object): Promise<unknown> => {
    const reply = await send(message);
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
  return { page, send, command };
}

/** Times every write of the operation journal from inside the service worker, as Chrome reports it. */
export const watchJournal = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as ChromeGlobal;
    if (scope.__journalMarks) return;
    const marks: JournalMark[] = [];
    scope.__journalMarks = marks;
    scope.chrome.storage.onChanged.addListener((changes, area) => {
      const written = changes["workspace-operation"]?.newValue as JournalMark | undefined;
      if (area !== "local" || written === undefined) return;
      const { id, kind, step, status } = written;
      marks.push({ id, kind, step, status, at: Date.now() });
    });
  });

/** The journal writes seen since `watchJournal`, in order. */
const journalMarks = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => (globalThis as unknown as ChromeGlobal).__journalMarks ?? []);

type Command = (message: object) => Promise<unknown>;

/**
 * Lifecycle commands by label; the first `open` of a label creates it at `url`, later ones switch.
 * `ids` carries the labels over to another driver, after a restart.
 */
export function identitiesAt(command: Command, url: string, ids = new Map<string, string>()) {
  const idOf = (label: string) => {
    const id = ids.get(label);
    if (id === undefined) throw new Error(`No identity ${label}.`);
    return id;
  };
  return {
    ids,
    idOf,
    open: async (label: string) => {
      const id = ids.get(label);
      if (id !== undefined) return command({ type: "workspace-switch", identityId: id });
      const created = (await command({ type: "workspace-new-identity", label, url })) as {
        id: string;
      };
      ids.set(label, created.id);
      return created;
    },
    resume: (label: string) => command({ type: "workspace-resume", identityId: idOf(label) }),
    suspend: () => command({ type: "workspace-suspend" }),
  };
}

/** How long each running step of one operation took, by the service worker's clock. */
export function stepDurations(marks: readonly JournalMark[]): Record<string, number> {
  const durations: Record<string, number> = {};
  for (const [index, mark] of marks.entries()) {
    const next = marks[index + 1];
    if (mark.status === "running" && next) durations[mark.step] = next.at - mark.at;
  }
  return durations;
}

/** The journal writes of the operations `run` starts, timed by the service worker. */
export async function marksOf(serviceWorker: Worker, run: () => Promise<unknown>) {
  const before = (await journalMarks(serviceWorker)).length;
  await run();
  return (await journalMarks(serviceWorker)).slice(before);
}

/** The open page at `url` that is not `previous`, once Chrome lists it. */
export async function nextPageAt(context: BrowserContext, url: string, previous?: Page) {
  if (previous) await expect.poll(() => previous.isClosed()).toBe(true);
  await expect
    .poll(() => context.pages().some((each) => each.url() === url && !each.isClosed()))
    .toBe(true);
  const page = context.pages().find((each) => each.url() === url && !each.isClosed());
  if (!page) throw new Error(`No page shows ${url}.`);
  return page;
}

/** A driver, the identities by label at the blank page, and the managed tab as it changes. */
export async function lifecycleSetUp(context: BrowserContext, serviceWorker: Worker) {
  await watchJournal(serviceWorker);
  const driver = await lifecycleDriver(context, serviceWorker);
  const identities = identitiesAt(driver.command, BLANK);
  const tab: { page?: Page } = {};
  /** The managed tab once the previous one closed. */
  const next = async () => {
    tab.page = await nextPageAt(context, BLANK, tab.page);
    return tab.page;
  };
  return { driver, identities, tab, next };
}
