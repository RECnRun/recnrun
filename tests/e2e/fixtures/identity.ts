import type { Worker } from "@playwright/test";
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
  };
}

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
