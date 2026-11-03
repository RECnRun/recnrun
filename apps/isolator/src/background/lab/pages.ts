import { messageOf } from "@/background/probes/helpers";
import type { DebuggerApi } from "@/background/probes/types";
import { command } from "@/background/route-a/attached";
import type { LabApis, PageRecord } from "@/background/lab/types";

/** How long a page may take to show its report; the fixture's pages report within seconds. */
const REPORT_WAIT_MS = 15_000;

/**
 * Runs in the page's isolated world, which the page cannot observe: the fixture's `#report` text
 * once it is `data-ready`, `null` on a page without one. Chrome serializes it, so it stays self-contained.
 */
function reportText(waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const element = document.getElementById("report");
      if (element === null) return resolve(null);
      if (element.dataset.ready !== undefined) return resolve(element.textContent);
      if (Date.now() > deadline) return resolve(`no report within ${waitMs} ms`);
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function names(
  run: () => Promise<Record<string, unknown>>,
  pick: (reply: Record<string, unknown>) => unknown,
): Promise<string[] | { error: string }> {
  try {
    const listed = pick(await run());
    return Array.isArray(listed) ? listed.map(String) : { error: "no list in Chrome's reply" };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** The physical store names of `origin`, through the armed tab's session (only reads). */
async function inventoryOf(api: DebuggerApi, tabId: number, origin: string) {
  const storageKey = `${origin}/`;
  const indexedDB = await names(
    () => command(api, { tabId }, "IndexedDB.requestDatabaseNames", { storageKey }),
    (reply) => reply.databaseNames,
  );
  const cacheStorage = await names(
    () => command(api, { tabId }, "CacheStorage.requestCacheNames", { storageKey }),
    (reply) => (reply.caches as { cacheName?: unknown }[] | undefined)?.map((c) => c.cacheName),
  );
  return { indexedDB, cacheStorage };
}

async function reportOf(apis: LabApis, tabId: number): Promise<string | null> {
  try {
    const injection = { func: reportText, args: [REPORT_WAIT_MS] as [number] };
    const [first] = await apis.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      ...injection,
    });
    return typeof first?.result === "string" ? first.result : null;
  } catch (error) {
    return `error: ${messageOf(error)}`;
  }
}

/** What a loaded page of an armed tab reported, then its origin's stores. */
export async function readPage(
  apis: LabApis,
  page: Omit<PageRecord, "report" | "indexedDB" | "cacheStorage">,
): Promise<PageRecord> {
  const report = await reportOf(apis, page.tabId);
  const origin = new URL(page.url).origin;
  return { ...page, report, ...(await inventoryOf(apis.debugger, page.tabId, origin)) };
}
