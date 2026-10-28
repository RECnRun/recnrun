import type { BrowserContext, Worker } from "@playwright/test";
import type { FirstReads } from "../apps/app-pages.ts";

/** One step's duration, as the test build's service worker reports it. */
export interface StepTiming {
  step: string;
  ms: number;
}

/** The test build's handles on the service worker (`src/background/test-handles.ts`). */
interface PocGlobal {
  recnrunPoc: {
    startWithIdentity: (url: string, data: unknown) => Promise<StepTiming[]>;
    setRestoreDelay: (ms: number) => void;
    failNext: (step: string) => void;
    captureIdentity: (identityId: string, capabilities?: unknown) => Promise<CaptureSummary>;
    startFromCapture: (identityId: string) => Promise<StepTiming[]>;
  };
}

/** A published capture's id, size, and duration, as the test build reports it. */
interface CaptureSummary {
  captureId: string;
  localStorage: number;
  sessionStorage: number;
  databases: number;
  records: number;
  caches: number;
  cacheEntries: number;
  cookies: number;
  unsupported: number;
  ms: number;
}

/** Captures the managed tab's page as `identityId`, keeping the cookies of `cookieHosts` too. */
export const captureIdentity = (
  serviceWorker: Worker,
  identityId: string,
  cookieHosts: string[] = [],
) =>
  serviceWorker.evaluate(
    ([id, hosts]) =>
      (globalThis as unknown as PocGlobal).recnrunPoc.captureIdentity(id, { cookieHosts: hosts }),
    [identityId, cookieHosts] as const,
  );

/** Starts a fresh managed window from `identityId`'s published capture. */
export const startFromCapture = (serviceWorker: Worker, identityId: string) =>
  serviceWorker.evaluate(
    (id) => (globalThis as unknown as PocGlobal).recnrunPoc.startFromCapture(id),
    identityId,
  );

/** What a run restores: a script cookie, an HttpOnly one naming the run, and the app's storage. */
export function identityFor(run: string) {
  const cookie = { path: "/", secure: false, sameSite: "lax" };
  return {
    cookies: [
      { ...cookie, name: "theme", value: `dark-${run}`, httpOnly: false },
      { ...cookie, name: "run", value: run, httpOnly: true },
    ],
    site: {
      localStorage: { token: `local-${run}` },
      sessionStorage: { tab: `session-${run}` },
      indexedDB: [
        {
          name: "app",
          version: 1,
          stores: [
            {
              name: "kv",
              keyPath: null,
              autoIncrement: false,
              records: [{ key: "marker", value: `idb-${run}` }],
            },
          ],
        },
      ],
    },
  };
}

/** What the app's first script must read once `identityFor(run)` is restored. */
export const restoredReads = (run: string): Omit<FirstReads, "time"> => ({
  cookie: `theme=dark-${run}`,
  localStorage: { token: `local-${run}` },
  sessionStorage: { tab: `session-${run}` },
  idbRecord: `idb-${run}`,
  controlled: false,
});

/** Starts the managed window at `url` with `data` restored first; resolves with the step timings. */
export function startWithIdentity(
  serviceWorker: Worker,
  url: string,
  data: unknown,
  restoreDelayMs = 0,
): Promise<StepTiming[]> {
  return serviceWorker.evaluate(
    async ([target, identity, delay]) => {
      const { recnrunPoc } = globalThis as unknown as PocGlobal;
      recnrunPoc.setRestoreDelay(delay);
      return recnrunPoc.startWithIdentity(target, identity);
    },
    [url, data, restoreDelayMs] as const,
  );
}

/** Makes the test build fail the next run of `step` once. */
export const failNext = (serviceWorker: Worker, step: string) =>
  serviceWorker.evaluate((name) => {
    (globalThis as unknown as PocGlobal).recnrunPoc.failNext(name);
  }, step);

interface ChromeGlobal {
  chrome: {
    storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } };
    tabs: { remove: (tabId: number) => Promise<void> };
    windows: { getAll: () => Promise<{ incognito: boolean }[]> };
    declarativeNetRequest: { getSessionRules: () => Promise<unknown[]> };
    scripting: { getRegisteredContentScripts: () => Promise<unknown[]> };
    cookies: {
      getAll: (filter: { url: string }) => Promise<unknown[]>;
      set: (details: { url: string; name: string; value: string }) => Promise<unknown>;
    };
  };
}

/** How many Incognito windows Chrome lists. */
export const incognitoWindows = (serviceWorker: Worker) =>
  serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return (await chrome.windows.getAll()).filter(({ incognito }) => incognito).length;
  });

/** What the barrier left behind: session rules and registered content scripts. */
export const barrierLeft = (serviceWorker: Worker) =>
  serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const rules = (await chrome.declarativeNetRequest.getSessionRules()).length;
    const scripts = (await chrome.scripting.getRegisteredContentScripts()).length;
    return { rules, scripts };
  });

/** The normal profile's cookies for `url`: the service worker's own store. */
export const normalCookies = (serviceWorker: Worker, url: string) =>
  serviceWorker.evaluate(async (target) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return chrome.cookies.getAll({ url: target });
  }, url);

/** Sets a cookie in the normal profile, which a start with an identity must leave alone. */
export const setNormalCookie = (serviceWorker: Worker, url: string) =>
  serviceWorker.evaluate(async (target) => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    await chrome.cookies.set({ url: target, name: "normal", value: "kept" });
  }, url);

/** The workspace operation the extension journaled, or null. */
export const journalOf = (serviceWorker: Worker) =>
  serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const stored = await chrome.storage.local.get("workspace-operation");
    return (stored["workspace-operation"] ?? null) as { step: string; status: string } | null;
  });

/** Closes a tab as the user would, from outside the start that uses it. */
export const closeTab = (serviceWorker: Worker, tabId: number) =>
  serviceWorker.evaluate(async (id) => {
    await (globalThis as unknown as ChromeGlobal).chrome.tabs.remove(id);
  }, tabId);

/** The extension's running worker, or the next one Chrome starts. */
export async function nextWorker(context: BrowserContext) {
  const [running] = context.serviceWorkers();
  return running ?? (await context.waitForEvent("serviceworker"));
}
