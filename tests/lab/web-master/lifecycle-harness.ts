import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { launchChrome } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import { attachExtension, loadUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";

/* Helpers of the W.lifecycle cell: the worker root's lifetime, the relayed link, and polling. */

const WORKER = fileURLToPath(new URL("worker-extension/", import.meta.url));
const LINK_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

export interface OpOutcome {
  op: string;
  state: string;
  result?: unknown;
  code?: string;
}

export interface JobStatus {
  jobId: string;
  state: string;
  ops: OpOutcome[];
}

export interface JobOp {
  op: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

/** Calls `window.lab[method]` of the master page. */
export function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([name, values]) => {
      const lab = (window as unknown as { lab: Record<string, (...x: unknown[]) => unknown> }).lab;
      return lab[name]?.(...values);
    },
    [method, args] as const,
  ) as Promise<T>;
}

export async function background<T>(worker: LoadedExtension, expression: string): Promise<T> {
  const value = (await worker.evaluateInBackground(expression)) as T | { error: string };
  if (value && typeof value === "object" && "error" in value) throw new Error(value.error);
  return value as T;
}

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms: number) {
  // Monotonic: a host sleep steps the container's wall clock forward past a Date.now deadline.
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (performance.now() > deadline)
      throw new Error(`Timed out after ${ms} ms: ${JSON.stringify(value)}`);
    await delay(POLL_MS);
  }
}

/**
 * Installs the worker into a fresh root as install.sh does: a pipe install, then Developer mode
 * and a reload (a CDP install is dropped at the next profile load otherwise), then Browser.close.
 */
export async function provisionWorker(): Promise<{ root: string; id: string }> {
  const root = await mkdtemp(join(tmpdir(), "recnrun-lab-worker-"));
  const installed = await loadUnpacked(WORKER, { userDataDir: root, transport: "pipe" });
  const id = installed.extensionId;
  const context =
    installed.chrome.browser.contexts()[0] ?? (await installed.chrome.browser.newContext());
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  const state = (want: string) =>
    page.evaluate(async (extension) => {
      const api = (globalThis as unknown as { chrome: { developerPrivate: DeveloperPrivate } })
        .chrome.developerPrivate;
      await api.updateProfileConfiguration({ inDeveloperMode: true });
      return (await api.getExtensionInfo(extension)).state;
    }, want);
  await page.evaluate(async (extension) => {
    const api = (globalThis as unknown as { chrome: { developerPrivate: DeveloperPrivate } }).chrome
      .developerPrivate;
    await api.updateProfileConfiguration({ inDeveloperMode: true });
    await api.reload(extension, { failQuietly: true });
  }, id);
  await until(
    () => state(id),
    (value) => value === "ENABLED",
    20_000,
  );
  await installed.chrome.pipe?.send("Browser.close", {}).catch(() => undefined);
  await until(() => Promise.resolve(installed.chrome.exited()), Boolean, 20_000);
  await installed.close();
  return { root, id };
}

interface DeveloperPrivate {
  updateProfileConfiguration(update: { inDeveloperMode: boolean }): Promise<void>;
  reload(id: string, options: { failQuietly: boolean }): Promise<void>;
  getExtensionInfo(id: string): Promise<{ state: string }>;
}

/** The worker root's browser endpoint, from the DevToolsActivePort file Chrome writes. */
async function workerEndpoint(root: string): Promise<string> {
  const read = () => readFile(join(root, "DevToolsActivePort"), "utf8").catch(() => "");
  const content = await until(read, (text) => text.trimEnd().split("\n").length >= 2, 20_000);
  const [port, path] = content.trimEnd().split("\n");
  return `ws://127.0.0.1:${port}${path}`;
}

/** Waits until every job the restart recovery closed has its result file complete. */
async function recoveryPublished(worker: LoadedExtension): Promise<void> {
  const recovered = await background<string[]>(worker, "lab.ready()");
  for (const jobId of recovered) {
    const file = () =>
      background<string | null>(worker, `lab.resultFile(${JSON.stringify(jobId)})`);
    await until(file, (path) => path !== null, 20_000);
  }
}

/**
 * Starts the provisioned root and waits until its restart recovery has run. Playwright connects
 * only after the recovery's result files are written: its connect renames downloads to GUIDs.
 */
export async function startWorker(root: string, id: string): Promise<LoadedExtension> {
  const flags = ["--enable-unsafe-extension-debugging", "--remote-debugging-port=0"];
  const launched = await launchChrome({ cdp: false, userDataDir: root, args: flags });
  const wsEndpoint = await workerEndpoint(root).catch(async (error: unknown) => {
    await launched.close();
    throw error;
  });
  // browser and cdp are set after the recovery; attachExtension reads only wsEndpoint and close.
  let browser: Browser | undefined;
  const close = async () => {
    await browser?.close().catch(() => undefined);
    await launched.close();
  };
  const chrome = { ...launched, strict: false, wsEndpoint, close } as unknown as LaunchedChrome;
  try {
    const worker = await attachExtension(chrome, id);
    await recoveryPublished(worker);
    browser = await chromium.connectOverCDP(wsEndpoint);
    chrome.browser = browser;
    chrome.cdp = await browser.newBrowserCDPSession();
    // Later result files keep their names in the worker's own Downloads folder.
    await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    return worker;
  } catch (error) {
    await close();
    throw error;
  }
}

/** SIGKILL of the worker root's browser process, by its pid only. */
export async function killWorker(worker: LoadedExtension): Promise<void> {
  process.kill(worker.chrome.pid, "SIGKILL");
  await until(
    () => Promise.resolve(worker.chrome.exited()),
    (exited) => exited,
    10_000,
  );
  await worker.close();
}

/** The harness relays the SDP (as in W.rtc); the page checks the worker's signed proof. */
export async function link(page: Page, worker: LoadedExtension, name: string): Promise<boolean> {
  const pinned = await background<JsonWebKey>(worker, "lab.identity()");
  const offer = await call<string>(page, "offer", name);
  const answer = await background<string>(worker, `lab.answer(${JSON.stringify(offer)})`);
  await Promise.race([
    call<number>(page, "accept", name, answer),
    delay(LINK_TIMEOUT_MS).then(() => {
      throw new Error(`channel ${name} did not open`);
    }),
  ]);
  return call<boolean>(page, "authenticate", name, pinned);
}

/** Pages of the master Chrome on the stand-in origin, read from the browser target list. */
export async function masterPages(master: LaunchedChrome, origin: string): Promise<number> {
  const { targetInfos } = await master.cdp.send("Target.getTargets");
  return targetInfos.filter((info) => info.type === "page" && info.url.startsWith(origin)).length;
}

export const jobOps = (target: string, jobId: string): JobOp[] => [
  { op: "navigate", args: { url: `${target}/form` }, timeoutMs: 10_000 },
  { op: "type", args: { selector: "#text", text: jobId }, timeoutMs: 5_000 },
  { op: "click", args: { selector: "#send" }, timeoutMs: 5_000 },
  { op: "wait", args: { selector: "#result", state: "attached" }, timeoutMs: 10_000 },
  { op: "read", args: { selector: "#result", what: "text", maxBytes: 1024 }, timeoutMs: 5_000 },
];
