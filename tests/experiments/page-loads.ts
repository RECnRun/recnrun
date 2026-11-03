import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test as base } from "../browser/fixtures/extension.ts";
import type { LoadedExtension } from "../browser/fixtures/extension.ts";
import { createObserver, currentRunId, evidenceName } from "../browser/observer/observer.ts";
import type { Observer } from "../browser/observer/observer.ts";
import { redact } from "../browser/observer/redact.ts";
import { takeSnapshot } from "../browser/observer/storage.ts";

export { expect };

// What E2, E5, and E7 share: one new tab per load, the fixture ledger, and the stores a load left.
export const APP = "http://app.localhost:4600";
export const API = "http://api.localhost:4601";
export const IDP = "http://idp.localhost:4602";
// Node does not resolve *.localhost everywhere, so the harness reaches the ledger on the loopback.
export const CONTROL = "http://127.0.0.1:4601";
export const REPORT_TIMEOUT_MS = 15_000;

export interface LedgerEntry {
  seq: number;
  origin: string;
  path: string;
  method: string;
  /** `empty` for fetch(), which the bootstrap marks; documents and scripts it never marks. */
  secFetchDest: string | null;
  marker: string | null;
  effect: string | null;
}

export interface Run {
  extension: LoadedExtension;
  context: BrowserContext;
}

export const test = base.extend<{ observer: Observer }>({
  observer: async ({ extension }, use, testInfo) => {
    const [context] = extension.chrome.browser.contexts();
    if (!context) throw new Error("Chrome has no default browser context");
    const observer = createObserver({
      cdp: extension.chrome.cdp,
      page: context.pages()[0] ?? (await context.newPage()),
      runId: currentRunId(),
      name: evidenceName(testInfo),
      ...(extension.label ? { label: extension.label } : {}),
    });
    await observer.start();
    try {
      await use(observer);
    } finally {
      await observer.finish();
    }
  },
});

/** Evaluates `expression` in the isolator's service worker, where the routes are globals. */
export async function evaluate<T>(extension: LoadedExtension, expression: string): Promise<T> {
  return (await extension.evaluateInBackground(expression)) as T;
}

/** `evaluate` of a member of `globalThis`, such as `recnrunRouteB.arm(...)`. */
export async function isolator<T>(extension: LoadedExtension, expression: string): Promise<T> {
  return evaluate<T>(extension, `globalThis.${expression}`);
}

export async function control(path: string, method = "POST"): Promise<Response> {
  const response = await fetch(`${CONTROL}${path}`, { method });
  expect(response.ok, `${method} ${path}`).toBe(true);
  return response;
}

export async function ledger(since = 0): Promise<LedgerEntry[]> {
  const entries = (await (await control("/__ledger", "GET")).json()) as LedgerEntry[];
  return entries.filter((entry) => entry.seq > since);
}

export async function checkpoint(): Promise<number> {
  return (await ledger()).at(-1)?.seq ?? 0;
}

/** Resets the network mode and the ledger, and denies the notification prompt nobody answers. */
export async function prepareFixture(extension: LoadedExtension): Promise<void> {
  await control("/__network?mode=online");
  await control("/__ledger/reset");
  await extension.chrome.cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "denied",
    origin: APP,
  });
}

export function pathOf(url: string): string {
  const parsed = new URL(url, APP);
  return parsed.pathname + parsed.search;
}

/** The `from` of a `/me?from=` request: the script of the worker that made it. */
export function fromOf(path: string): string | null {
  return new URL(path, API).searchParams.get("from");
}

/** Waits for the page's `#report`, or for `selector` when the page reports elsewhere. */
export async function reportOf(page: Page, url: string, selector = "#report[data-ready]") {
  await page.goto(url);
  const element = page.locator(selector);
  const ready = await element.waitFor({ timeout: REPORT_TIMEOUT_MS }).then(
    () => true,
    () => false,
  );
  if (!ready) return { error: `no report within ${REPORT_TIMEOUT_MS} ms` };
  const text = (await element.textContent()) ?? "null";
  return (text.startsWith("{") ? JSON.parse(text) : text) as unknown;
}

/** Waits until the ledger after `since` holds the marker `name`. */
export async function markerSeen(since: number, name: string): Promise<void> {
  const seen = async () => (await ledger(since)).some((entry) => entry.marker === name);
  await expect.poll(seen, { timeout: REPORT_TIMEOUT_MS }).toBe(true);
}

/** The tab id Route A's `tabs()` gives the page once it shows `blank`. */
export async function tabOf(extension: LoadedExtension, page: Page, blank: string) {
  await page.goto(blank);
  const tabs = await evaluate<{ tabId: number; url: string }[]>(
    extension,
    "globalThis.recnrunRouteA.tabs()",
  );
  const tab = tabs.find((candidate) => candidate.url === blank);
  if (!tab) throw new Error(`no tab at ${blank}: ${JSON.stringify(tabs)}`);
  return tab.tabId;
}

/** IndexedDB names the page's frame resolves for `origin`, so the session is the page's. */
export async function inventoryOf(run: Run, page: Page, label: string, origin = APP) {
  const session = await run.context.newCDPSession(page);
  const sessions = { page: session, browser: run.extension.chrome.cdp };
  const snapshot = await takeSnapshot(sessions, [origin], label);
  await session.detach();
  return snapshot.origins[origin];
}

// A blob: or data: shared worker belongs to the page that built it, so the wait covers those too.
function isAppSharedWorker({ type, url }: { type: string; url: string }): boolean {
  if (type !== "shared_worker") return false;
  return url.startsWith(APP) || url.startsWith(`blob:${APP}`) || url.startsWith("data:");
}

/** Targets of `type` on the app origin that Chrome still lists, with their ids. */
export async function targetsLeft(run: Run, type: string): Promise<{ id: string; url: string }[]> {
  const { targetInfos } = await run.extension.chrome.cdp.send("Target.getTargets");
  return targetInfos
    .filter((info) => info.type === type && info.url.startsWith(APP))
    .map(({ targetId, url }) => ({ id: targetId, url: pathOf(url) }));
}

/** Shared workers still alive, which the next load would join instead of starting its own. */
export async function sharedWorkersLeft(run: Run): Promise<string[]> {
  const { targetInfos } = await run.extension.chrome.cdp.send("Target.getTargets");
  return targetInfos.filter(isAppSharedWorker).map(({ url }) => url.slice(0, 120));
}

/** Closes the load's tab and waits until no shared worker of the app outlives it. */
export async function closeAndSettle(run: Run, page: Page): Promise<void> {
  // A navigation keeps the last page in the back/forward cache with its shared worker; a closed tab does not.
  await page.close();
  await expect.poll(() => sharedWorkersLeft(run), { timeout: REPORT_TIMEOUT_MS }).toEqual([]);
}

export async function writeSamples(directory: string, evidence: unknown[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  const text = `${JSON.stringify(redact(evidence), null, 2)}\n`;
  await writeFile(join(directory, "samples.json"), text);
}
