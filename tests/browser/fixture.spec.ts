import type { Page, TestInfo } from "@playwright/test";
import { cookieValues, expect, expectRedactedEvidence, test } from "./observer/fixture.ts";

// The fixture's public pages hardcode these default ports (apps/fixture/README.md).
const APP = "http://app.localhost:4600";
const STAGING = "http://app.localhost:4603";
// Node does not resolve *.localhost everywhere, so the harness reaches the API on the loopback.
const CONTROL = "http://127.0.0.1:4601";
const ORIGINS = [APP, STAGING, "http://api.localhost:4601", "http://idp.localhost:4602"];
const SW_VARIANTS = ["classic", "module", "imports", "static", "dynamic"] as const;

interface LedgerEntry {
  seq: number;
  origin: string;
  path: string;
  user: string | null;
  marker: string | null;
  effect: string | null;
}

interface WorkerReport {
  user: string | null;
  script?: string;
}

interface ServiceWorkerPageReport {
  sync: string;
  push: string;
  worker: WorkerReport;
}

async function control(path: string, method = "POST"): Promise<Response> {
  const response = await fetch(`${CONTROL}${path}`, { method });
  expect(response.ok, `${method} ${path}`).toBe(true);
  return response;
}

async function ledger(): Promise<LedgerEntry[]> {
  return (await (await control("/__ledger", "GET")).json()) as LedgerEntry[];
}

async function report<T>(page: Page, url: string): Promise<T> {
  await control("/__ledger/reset");
  await page.goto(url);
  const element = page.locator("#report[data-ready]");
  await element.waitFor();
  return JSON.parse((await element.textContent()) ?? "null") as T;
}

async function signIn(page: Page, user: string, origin = APP): Promise<void> {
  await page.goto(`${origin}/`);
  await expect(page.locator("#user")).toHaveText("Signed out");
  await page.getByRole("link", { name: "Log in" }).click();
  await page.getByRole("textbox").fill(user);
  await page.getByRole("button").click();
  await page.waitForURL(`${origin}/`);
  await expect(page.locator("#user")).toHaveText(`Signed in as ${user}`);
}

function seqOf(entries: LedgerEntry[], what: string, match: (entry: LedgerEntry) => boolean) {
  const entry = entries.find(match);
  expect(entry, `${what} in the ledger`).toBeDefined();
  return entry?.seq ?? Number.NaN;
}

/** The worker's first authenticated request lands between the page's start and first-paint markers. */
async function expectFirstRequestBeforePaint(page: string, scripts: string[], user: string) {
  // The page sends first-paint after it shows its report, so wait for the marker to land.
  await expect
    .poll(async () => (await ledger()).some((entry) => entry.marker === `${page}:first-paint`))
    .toBe(true);
  const entries = await ledger();
  const start = seqOf(entries, `${page}:start`, (entry) => entry.marker === `${page}:start`);
  const paint = seqOf(
    entries,
    `${page}:first-paint`,
    (entry) => entry.marker === `${page}:first-paint`,
  );
  for (const script of scripts) {
    const from = `/me?from=${encodeURIComponent(script)}`;
    const first = seqOf(entries, `${from} as ${user}`, (entry) => entry.path === from);
    expect(entries.find((entry) => entry.seq === first)?.user).toBe(user);
    expect(first, `${script} after ${page}:start`).toBeGreaterThan(start);
    expect(first, `${script} before ${page}:first-paint`).toBeLessThan(paint);
  }
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

function recordFact(testInfo: TestInfo, description: string): void {
  testInfo.annotations.push({ type: "chrome fact", description });
  console.log(`Chrome fact: ${description}`);
}

test.beforeEach(async () => {
  await control("/__network?mode=online");
});

// Every test leaves the evidence set; the fixture's session cookies never appear in it unhashed.
test.afterEach(async ({ chrome, observer }) => {
  await observer.snapshotStorage(ORIGINS);
  await observer.collectLedger(CONTROL);
  const secrets = await cookieValues(chrome.cdp, ["api_sid", "idp_sid"]);
  await expectRedactedEvidence(await observer.finish(), secrets);
});

test("serves storage, both worker types, and sockets to the user signed in by redirect", async ({
  observer,
}, testInfo) => {
  const { page } = observer;
  await signIn(page, "alice");
  await screenshot(page, testInfo, "signed-in");

  const storage = await report<Record<string, string>>(page, `${APP}/storage.html`);
  expect(storage.user).toBe("alice");
  expect(Object.values(storage).filter((value) => value.startsWith("error:"))).toEqual([]);

  for (const type of ["classic", "module"]) {
    const workers = await report<Record<string, WorkerReport>>(
      page,
      `${APP}/workers.html?type=${type}`,
    );
    expect([workers.dedicated?.user, workers.shared?.user]).toEqual(["alice", "alice"]);
    const scripts = [`/worker.js?type=${type}`, `/shared-worker.js?type=${type}`];
    await expectFirstRequestBeforePaint("workers", scripts, "alice");
  }

  const sockets = await report<{ webSocket: string; eventSource: WorkerReport }>(
    page,
    `${APP}/sockets.html`,
  );
  expect(sockets).toEqual({ webSocket: "ping", eventSource: { user: "alice" } });
});

test("runs every service worker variant and serves the offline shell when the fixture cuts the network", async ({
  chrome,
  observer,
}, testInfo) => {
  test.setTimeout(120_000);
  const { page } = observer;
  // Headed Chrome holds pushManager.subscribe() on a permission prompt nobody answers; deny it instead.
  await chrome.cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "denied",
    origin: APP,
  });
  await signIn(page, "alice");

  for (const variant of SW_VARIANTS) {
    const sw = await report<ServiceWorkerPageReport>(page, `${APP}/sw.html?sw=${variant}`);
    expect(sw.worker.user, variant).toBe("alice");
    expect(sw.sync, variant).toBe("ok");
    await expectFirstRequestBeforePaint("sw", [sw.worker.script ?? ""], "alice");
    // A fact, not a failure: without the notification permission Chrome refuses the subscription.
    expect(sw.push, variant).toMatch(/^error: NotAllowedError: /);
    recordFact(testInfo, `${variant}: push subscription ${sw.push}`);
  }
  const dynamic = (await ledger()).find((entry) => entry.marker?.startsWith("sw:dynamic-import:"));
  // Chrome rejects import() in service workers by design (HTML spec), so the fixture records a TypeError.
  expect(dynamic?.marker).toBe("sw:dynamic-import:TypeError");
  recordFact(testInfo, `dynamic: import() in a service worker gives ${dynamic?.marker}`);

  await control("/__network?mode=offline");
  await page.goto(`${APP}/storage.html`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offline");
  await screenshot(page, testInfo, "offline-shell");
  const navigation = (await ledger()).find((entry) => entry.path === "/storage.html");
  expect(navigation?.effect).toBe("network:dropped");
});

test("logs in by popup, renews silently, logs out, and serves the staging copy", async ({
  observer,
}, testInfo) => {
  const { page } = observer;
  await page.goto(`${APP}/`);
  await expect(page.locator("#user")).toHaveText("Signed out");

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Log in in a popup" }).click(),
  ]);
  await popup.getByRole("textbox").fill("bob");
  await popup.getByRole("button").click();
  await expect(page.locator("#log")).toContainText('"type": "fixture-login"');
  await expect(page.locator("#user")).toHaveText("Signed in as bob");

  await page.getByRole("button", { name: "Silent renew" }).click();
  await expect(page.locator("#log")).toContainText('"type": "fixture-renew"');
  await expect(page.locator("#log")).toContainText('"ok": true');

  await page.getByRole("link", { name: "Log out" }).click();
  await expect(page.locator("#user")).toHaveText("Signed out");

  await signIn(page, "carol", STAGING);
  await screenshot(page, testInfo, "staging");
  const staging = (await ledger()).filter((entry) => entry.origin === STAGING);
  expect(staging.some((entry) => entry.path === "/index.js")).toBe(true);
});
