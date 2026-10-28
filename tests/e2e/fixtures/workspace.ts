import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect } from "./extension.ts";
import { clickInDashboard, dashboardOf } from "./session.ts";

/** The POC fixture application, served by `tests/e2e/apps/server.ts`. */
export const APP = "http://app.localhost:5192";

interface ManagedWindow {
  generation: number;
  windowId: number;
  tabId: number;
  status: "active" | "closed";
}

interface StorageGlobal {
  chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
}

export const workspacePanel = (site: Page) =>
  dashboardOf(site).getByRole("region", { name: "Incognito workspace" });

/** The managed Incognito window as the extension stored it, or null before the first Start. */
export function managedWindow(serviceWorker: Worker): Promise<ManagedWindow | null> {
  return serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as StorageGlobal;
    const stored = await chrome.storage.local.get("managed-window");
    return (stored["managed-window"] ?? null) as ManagedWindow | null;
  });
}

/** Types the address in the dashboard's workspace panel and clicks one of its buttons. */
export async function runWorkspace(site: Page, url: string, action: string): Promise<void> {
  const panel = workspacePanel(site);
  await panel.getByRole("textbox", { name: "Address" }).fill(url);
  await clickInDashboard(panel.getByRole("button", { name: action, exact: true }));
}

/** Starts the managed Incognito window at `url` from the dashboard; resolves with its tab id. */
export async function startWorkspace(site: Page, serviceWorker: Worker, url: string) {
  await runWorkspace(site, url, "Start");
  await expect(workspacePanel(site)).toContainText("Incognito workspace open");
  const managed = await managedWindow(serviceWorker);
  if (managed?.status !== "active") throw new Error("No managed window opened.");
  return managed.tabId;
}

/** The Playwright page of the tab Chrome opened at `url`, incognito ones included. */
export async function pageAt(context: BrowserContext, url: string): Promise<Page> {
  await expect.poll(() => context.pages().some((each) => each.url() === url)).toBe(true);
  const found = context.pages().find((each) => each.url() === url);
  if (!found) throw new Error(`No page shows ${url}.`);
  return found;
}

/** The managed tab, the only one RECnRun records: its Playwright page, address, and Chrome id. */
export interface WorkspaceApp {
  page: Page;
  url: string;
  id: number;
}

/** Starts the managed window at `url` from the site's dashboard and finds its tab. */
export async function openWorkspaceApp(
  site: Page,
  serviceWorker: Worker,
  url: string,
): Promise<WorkspaceApp> {
  const id = await startWorkspace(site, serviceWorker, url);
  return { id, url, page: await pageAt(site.context(), url) };
}
