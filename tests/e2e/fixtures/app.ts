import type { Page } from "@playwright/test";
import type { AppState, FirstReads } from "../apps/app-pages.ts";
import { LOG } from "./sentinels.ts";

/** One line of the fixture server's log for a run id. */
export interface AppLogEntry {
  kind: "request" | "report";
  method?: string;
  path?: string;
  dest?: string;
  time: number;
  body?: unknown;
}

/** What the observer reads first on an origin that holds nothing. */
export const EMPTY_FIRST_READS: Omit<FirstReads, "time"> = {
  cookie: "",
  localStorage: {},
  sessionStorage: {},
  idbRecord: null,
};

interface AppWindow {
  __app?: AppState;
}

/** Waits until every part of the `/app/` page ran, then returns what it observed. */
export async function appState(page: Page): Promise<AppState> {
  const handle = await page.waitForFunction(() => {
    const app = (window as AppWindow).__app;
    return app?.done === true || app?.failure !== undefined ? app : undefined;
  });
  return (await handle.jsonValue()) as AppState;
}

/** The fixture server's log for `run`: every request and every beacon, in arrival order. */
export async function appLog(run: string): Promise<AppLogEntry[]> {
  const response = await fetch(`${LOG}?run=${encodeURIComponent(run)}`);
  return ((await response.json()) as { entries: AppLogEntry[] }).entries;
}

/** The requests of a run as `path dest`, e.g. `/app/module.js script`. */
export const requestsOf = (entries: readonly AppLogEntry[]) =>
  entries.filter(({ kind }) => kind === "request").map(({ path, dest }) => `${path} ${dest}`);
