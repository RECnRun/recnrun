import type { Page } from "@playwright/test";
import { expect, test } from "../browser/fixtures/extension.ts";
import type { LoadedExtension } from "../browser/fixtures/extension.ts";
import { browserOf, provenance, summarize } from "./e1-aggregate.ts";
import type { ProbeResult } from "./e1-aggregate.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";

// Hypotheses of PLAN.md P0.4; docs/poc/namespace-sessions/experiments/E1.md reports them.
// The harness only drives pages and reads results: every chrome.debugger call runs in the isolator.
const SAMPLES = 3;
const APP = "http://app.localhost:4600";
// Node does not resolve *.localhost everywhere, so the harness reaches the ledger on the loopback.
const CONTROL = "http://127.0.0.1:4601";
const URLS = {
  pageUrl: `${APP}/workers.html`,
  serviceWorkerUrl: `${APP}/sw-main.js`,
  sharedWorkerUrl: `${APP}/shared-worker.js`,
  dedicatedWorkerUrl: `${APP}/worker.js`,
  iframeUrl: "http://idp.localhost:4602/whoami",
  cookieUrl: `${APP}/`,
};
const WORKER_SCRIPTS = [
  "/sw-main.js?variant=classic",
  "/worker.js?type=classic",
  "/shared-worker.js?type=classic",
];
const HARNESS = "globalThis.recnrunProbes";
const INFOBAR = "infobar-hidden";
const INFOBAR_DESCRIPTION =
  "the debugger infobar stays hidden with --silent-debugger-extension-api";
const INFOBAR_SETTLE_MS = 1_000;

async function ledgerPaths(): Promise<string[]> {
  const response = await fetch(`${CONTROL}/__ledger`);
  return ((await response.json()) as { path: string }[]).map((entry) => entry.path);
}

/** Every worker of the fixture made its first authenticated request. */
async function workersStarted(): Promise<boolean> {
  const paths = await ledgerPaths();
  return WORKER_SCRIPTS.every((script) => paths.includes(`/me?from=${encodeURIComponent(script)}`));
}

async function openWorkersPage(page: Page): Promise<void> {
  await page.goto(`${URLS.pageUrl}?type=classic`);
  await page.locator("#report[data-ready]").waitFor();
}

async function background<T>(extension: LoadedExtension, expression: string): Promise<T> {
  return (await extension.evaluateInBackground(expression)) as T;
}

/** chrome:// targets (browser UI); the omnibox popup is always there, so only new ones count. */
async function chromeTargets(extension: LoadedExtension): Promise<string[]> {
  const { targetInfos } = (await extension.chrome.cdp.send("Target.getTargets")) as {
    targetInfos: { type: string; url: string }[];
  };
  return targetInfos
    .filter((target) => target.url.startsWith("chrome://"))
    .map((target) => `${target.type} ${target.url}`);
}

interface Viewport {
  tabHeight: number;
  chromeTargets: string[];
}

/** The tab's height comes from the isolator (`chrome.tabs`), so the harness never evaluates in the page. */
async function viewport(extension: LoadedExtension): Promise<Viewport> {
  const tabHeight = await background<number>(
    extension,
    `${HARNESS}.tabHeight(${JSON.stringify(URLS.pageUrl)})`,
  );
  return { tabHeight, chromeTargets: await chromeTargets(extension) };
}

/**
 * The infobar would shrink the tab or add a chrome:// target; neither should happen.
 * `before` is taken once before any attach: a shown infobar outlives the detach that follows.
 */
async function infobarSample(
  extension: LoadedExtension,
  page: Page,
  before: Viewport,
): Promise<ProbeResult> {
  const tabId = await background<number>(
    extension,
    `${HARNESS}.holdTab(${JSON.stringify(URLS.pageUrl)})`,
  );
  try {
    await page.waitForTimeout(INFOBAR_SETTLE_MS);
    const during = await viewport(extension);
    const added = during.chromeTargets.filter((target) => !before.chromeTargets.includes(target));
    const detail = { evidence: "chrome.tabs height", before, during };
    if (during.tabHeight === before.tabHeight && added.length === 0) {
      return { id: INFOBAR, status: "allowed", detail };
    }
    const error = `tab height ${before.tabHeight} -> ${during.tabHeight}; new chrome:// targets: ${added.join(", ") || "none"}`;
    return { id: INFOBAR, status: "rejected", error, detail };
  } finally {
    await background(extension, `${HARNESS}.releaseTab(${tabId})`);
  }
}

/** Records each probe's verdict and returns its `capabilities.json` entry. */
async function record(
  extension: LoadedExtension,
  samples: Map<string, ProbeResult[]>,
): Promise<Record<string, unknown>> {
  const descriptions = await background<Record<string, string>>(
    extension,
    `${HARNESS}.descriptions`,
  );
  const { verdicts, capabilities } = summarize(
    samples,
    { ...descriptions, [INFOBAR]: INFOBAR_DESCRIPTION },
    browserOf(extension),
  );
  for (const verdict of verdicts) await appendVerdict(verdict);
  return capabilities;
}

async function permissions(extension: LoadedExtension) {
  const manifest = await background<{ permissions?: string[]; host_permissions?: string[] }>(
    extension,
    "chrome.runtime.getManifest()",
  );
  return {
    permissions: manifest.permissions ?? [],
    hostPermissions: manifest.host_permissions ?? [],
  };
}

test.describe("E1: chrome.debugger capabilities from inside the isolator", () => {
  test.describe.configure({ timeout: 300_000 });

  test("every probe runs on the fixture's workers and gets a recorded result", async ({
    extension,
  }) => {
    const [context] = extension.chrome.browser.contexts();
    if (!context) throw new Error("Chrome has no default browser context");
    await fetch(`${CONTROL}/__ledger/reset`, { method: "POST" });
    const swPage = context.pages()[0] ?? (await context.newPage());
    await swPage.goto(`${APP}/sw.html?sw=classic`);
    const page = await context.newPage();

    const ids = await background<string[]>(extension, `${HARNESS}.ids`);
    const samples = new Map<string, ProbeResult[]>([...ids, INFOBAR].map((id) => [id, []]));
    let baseline: Viewport | undefined;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await openWorkersPage(page);
      await expect.poll(workersStarted, { timeout: 15_000 }).toBe(true);
      baseline ??= await viewport(extension);
      samples.get(INFOBAR)?.push(await infobarSample(extension, page, baseline));
      const results = await background<ProbeResult[]>(
        extension,
        `${HARNESS}.run(${JSON.stringify(URLS)})`,
      );
      for (const result of results) samples.get(result.id)?.push(result);
    }

    const ran = [...samples].filter(([, results]) => results.length >= SAMPLES).map(([id]) => id);
    expect(ran, "every probe ran").toEqual([...ids, INFOBAR]);
    expect(ids.length, "the isolator exposes its probe table").toBeGreaterThan(0);

    const merged = await mergeCapabilities({
      chrome: { version: extension.chrome.version },
      debuggerProbe: {
        date: new Date().toISOString().slice(0, 10),
        samples: SAMPLES,
        ...provenance(browserOf(extension)),
        ...(await permissions(extension)),
      },
      debugger: await record(extension, samples),
    });
    console.log(
      JSON.stringify(merged.debugger, (key, value) => (key === "details" ? undefined : value)),
    );
  });
});
