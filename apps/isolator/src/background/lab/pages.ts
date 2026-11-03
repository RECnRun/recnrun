import { messageOf } from "@/background/probes/helpers";
import type { DebuggerApi } from "@/background/probes/types";
import { command } from "@/background/route-a/attached";
import type { LabApis, PageRecord, PageView } from "@/background/lab/types";

/** How long a page may take to show its report; the fixture's pages report within seconds. */
const REPORT_WAIT_MS = 15_000;

/**
 * Runs in the page's isolated world, which the page cannot observe: the fixture's `#report` text
 * once it is `data-ready` (`null` on a page without one), then the origin's IndexedDB names, which
 * the isolated world reads unpatched. Chrome serializes it, so it stays self-contained.
 */
function pageView(waitMs: number): Promise<PageView> {
  const deadline = Date.now() + waitMs;
  const databases = (): Promise<PageView["databases"]> =>
    indexedDB.databases().then(
      (list) => list.map((database) => database.name ?? ""),
      (error: unknown) => ({ error: String(error) }),
    );
  return new Promise((resolve) => {
    const done = (report: string | null): void =>
      void databases().then((list) => resolve({ report, databases: list }));
    const tick = (): void => {
      const element = document.getElementById("report");
      if (element === null) return done(null);
      if (element.dataset.ready !== undefined) return done(element.textContent);
      if (Date.now() > deadline) return done(`no report within ${waitMs} ms`);
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

/** The physical Cache Storage names of `origin`, through the armed tab's session (only reads). */
function cachesOf(api: DebuggerApi, tabId: number, origin: string) {
  return names(
    () => command(api, { tabId }, "CacheStorage.requestCacheNames", { storageKey: `${origin}/` }),
    (reply) => (reply.caches as { cacheName?: unknown }[] | undefined)?.map((c) => c.cacheName),
  );
}

function isPageView(value: unknown): value is PageView {
  return typeof value === "object" && value !== null && "report" in value && "databases" in value;
}

async function viewOf(apis: LabApis, tabId: number): Promise<PageView> {
  try {
    const injection = { func: pageView, args: [REPORT_WAIT_MS] as [number] };
    const [first] = await apis.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      ...injection,
    });
    const view = first?.result;
    return isPageView(view) ? view : { report: null, databases: { error: "no page view" } };
  } catch (error) {
    const failed = `error: ${messageOf(error)}`;
    return { report: failed, databases: { error: failed } };
  }
}

/** What a loaded page of an armed tab reported, then its origin's stores. */
export async function readPage(
  apis: LabApis,
  page: Omit<PageRecord, "report" | "indexedDB" | "cacheStorage">,
): Promise<PageRecord> {
  const { report, databases } = await viewOf(apis, page.tabId);
  const cacheStorage = await cachesOf(apis.debugger, page.tabId, new URL(page.url).origin);
  return { ...page, report, indexedDB: databases, cacheStorage };
}
