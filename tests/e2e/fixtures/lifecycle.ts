import type { BrowserContext, Page, Worker } from "@playwright/test";

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
export const journalMarks = (serviceWorker: Worker) =>
  serviceWorker.evaluate(() => (globalThis as unknown as ChromeGlobal).__journalMarks ?? []);
