// The lab's dashboard: the person tests from a page of the extension instead of the service
// worker's console. Playwright only clicks it, as the person would.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import {
  artifacts,
  launchLab,
  restartExtension as restart,
  signIn,
  ssoSession,
  writeEvidence,
  writeUnpacked,
} from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();
const SCREENSHOT = join(artifacts, "dashboard.png");

/** Opens the dashboard as the toolbar button does. */
async function openDashboard({ context, worker }) {
  const next = context.waitForEvent("page");
  await worker.evaluate(() => globalThis.lab.openDashboard());
  const page = await next;
  await page.waitForSelector("#identity");
  return page;
}

/** Clicks `selector` and waits until the dashboard is idle again; returns the newest log entry. */
async function act(dashboard, selector) {
  await dashboard.click(selector);
  await dashboard.waitForFunction(() => !document.body.classList.contains("busy"), null, {
    timeout: 60000,
  });
  return dashboard.textContent("#log li:first-child");
}

const identity = (dashboard) => dashboard.textContent("#identity");

/** Start, B from empty, bob signs in, back to A: every step a click on the dashboard. */
async function switchRound(dashboard, app, steps) {
  steps.site = await dashboard.textContent("#site");
  steps.before = await identity(dashboard);
  steps.start = await act(dashboard, "#start");
  await dashboard.fill("#to", "B");
  steps.toB = await act(dashboard, "#switch");
  steps.b = await ssoSession(app);
  steps.bSignedIn = await signIn(app, "bob");
  steps.toA = await act(dashboard, '[data-switch="A"]');
  steps.backToA = await ssoSession(app);
  steps.identity = await identity(dashboard);
  steps.captures = await dashboard.$$eval("[data-capture]", (rows) =>
    rows.map((row) => row.dataset.capture),
  );
  await dashboard.screenshot({ path: SCREENSHOT, fullPage: true });
}

/** Restores B's cookies, turns forced clearing on, and forgets everything in two clicks. */
async function settingsRound(dashboard, session, steps) {
  steps.restore = await act(dashboard, '[data-cookies="B"]');
  await dashboard.check("#force-clear");
  await dashboard.waitForFunction(() => !document.body.classList.contains("busy"));
  steps.forceClear = await session.worker.evaluate(() => globalThis.lab.configure({}).forceClear);
  steps.forgetFirst = await act(dashboard, "#forget");
  steps.capturesAfterOneClick = (await session.lab.captures()).length;
  steps.forget = await act(dashboard, "#forget");
  steps.capturesAfter = await session.lab.captures();
  // The setting outlives the worker, as the preset does; the reload closes the dashboard.
  const { worker } = await restart(session);
  steps.forceClearAfterRestart = await worker.evaluate(async () => {
    await globalThis.lab.ready();
    return globalThis.lab.configure({}).forceClear;
  });
}

await test("dashboard: start, switch, restore cookies, and forget, without the console", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recnrun-origin-lab-unpacked-")), "unpacked");
  writeUnpacked({ url: `${APP}/sso-app`, cookieHosts: ["sso.localhost"] }, dir);
  const session = await launchLab({ extension: dir });
  const steps = {};
  evidence.dashboard = steps;
  try {
    const app = await session.context.newPage();
    await app.goto(`${APP}/sso-app`);
    steps.a = await signIn(app, "alice");
    const dashboard = await openDashboard(session);
    await switchRound(dashboard, app, steps);
    await settingsRound(dashboard, session, steps);
    console.log(JSON.stringify({ dashboard: steps }));
    assert.equal(steps.site, "http://app.localhost:4330");
    assert.equal(steps.before, "not started");
    assert.match(steps.start, /RECnRun · A/);
    assert.match(steps.toB, /A → B: start, 1 tab/);
    assert.deepEqual(steps.b, { login: true });
    assert.match(steps.toA, /B → A: resume/);
    assert.deepEqual(steps.backToA, { user: "alice", profile: "alice" });
    assert.equal(steps.identity, "A");
    assert.deepEqual(steps.captures, ["A", "B"]);
    assert.match(steps.restore, /B's cookies: 1 removed, 1 set/);
    assert.equal(steps.forceClear, true);
    assert.equal(steps.forceClearAfterRestart, true);
    assert.equal(steps.capturesAfterOneClick, 2, "one click only asks to confirm");
    assert.deepEqual(steps.capturesAfter, []);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("dashboard: only the dashboard page may send its commands", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recnrun-origin-lab-unpacked-")), "unpacked");
  writeUnpacked({ url: `${APP}/app`, cookieHosts: [] }, dir);
  const session = await launchLab({ extension: dir });
  try {
    const app = await session.context.newPage();
    await app.goto(`${APP}/app`);
    // The gate's content script runs in the app's tabs: its messages carry the app's URL.
    const answer = await session.worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}/*` });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => chrome.runtime.sendMessage({ ui: "forget" }),
      });
      return result;
    }, APP);
    evidence.sender = answer;
    console.log(JSON.stringify({ sender: answer }));
    assert.deepEqual(answer, { ok: false, error: "not from the dashboard" });
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await fixture.close();
writeEvidence("dashboard", evidence);
