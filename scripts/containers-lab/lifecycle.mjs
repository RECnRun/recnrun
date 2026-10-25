// Phase E, the tab and extension lifecycle in N2B1: Admin and the control sign in, then each case
// does what a user (or Chrome) does to the Admin tab, and reads the identity it ends up with.
// Run: node scripts/containers-lab/lifecycle.mjs [case...]
import { APP, startFixture } from "./fixture-server.mjs";
import {
  launchLab,
  pageLab,
  openTab,
  readAfterReloads,
  signIn,
  whoAmI,
  writeEvidence,
} from "./lab-browser.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const homeUser = (page) => readAfterReloads(page, "**/home");

/** The first render, then the one after the reload the extension may start once it holds the tab. */
async function settledUser(page) {
  const first = await homeUser(page);
  await pause(2000);
  await page.waitForLoadState();
  return { first, settled: await page.textContent("#user") };
}
const groupOf = async (lab, url) => (await lab.tabs()).find((tab) => tab.url === url)?.group;

async function setup(handle) {
  await handle.lab.setVariant("N2B1");
  const admin = await openTab(handle, "Admin");
  const control = await openTab(handle, undefined);
  return {
    admin,
    control,
    signedIn: [await signIn(admin.page, "Admin"), await signIn(control.page, "Control")],
  };
}

/** Settles with `fallback` when `promise` takes longer than `ms`. */
const within = (promise, ms, fallback) => Promise.race([promise, pause(ms).then(() => fallback)]);

/** Every identity the tab's back-to-back requests carry over the 4 seconds after the extension went away. */
async function probes(page) {
  return page.evaluate(async () => {
    const seen = {};
    let slowestMs = 0;
    for (const end = Date.now() + 4000; Date.now() < end;) {
      const started = Date.now();
      const user = await fetch("/me")
        .then((response) => response.json())
        .then(
          (body) => String(body.user),
          (error) => error.name,
        );
      seen[user] = (seen[user] ?? 0) + 1;
      slowestMs = Math.max(slowestMs, Date.now() - started);
    }
    return { seen, slowestMs };
  });
}

/** The lab handle of the extension's next service worker, through an extension page. */
async function nextLab(handle) {
  const lab = await pageLab(handle.context, new URL(handle.worker.url()).host);
  await within(lab.ready(), 20000, undefined);
  return lab;
}

async function ctrlClick(handle, { admin }) {
  await admin.page.goto(`${APP}/links`);
  const opened = handle.context.waitForEvent("page");
  await admin.page.click("#home", { modifiers: ["ControlOrMeta"] });
  const page = await opened;
  return {
    rendered: await settledUser(page),
    fetched: await whoAmI(page),
    group: await groupOf(handle.lab, page.url()),
  };
}

async function duplicate(handle, { admin }) {
  const opened = handle.context.waitForEvent("page");
  await handle.lab.duplicate(admin.tabId);
  const page = await opened;
  return {
    rendered: await settledUser(page),
    fetched: await whoAmI(page),
    tabs: await handle.lab.tabs(),
  };
}

/** Requester never signed in, so the moved tab must turn signed out, with Requester's storage. */
async function move(handle) {
  const tab = await openTab(handle, "Admin", "/apis");
  await tab.page.waitForFunction(() => window.apis !== undefined);
  await tab.page.evaluate(() => window.apis.write("Admin"));
  await tab.page.evaluate(() => (window.beforeMove = true));
  await handle.lab.group(tab.tabId, "Requester");
  await tab.page
    .waitForFunction(() => window.apis !== undefined && !window.beforeMove)
    .catch(() => {});
  const localStorage = await tab.page.evaluate(() =>
    window.apis.read().then((read) => read.localStorage),
  );
  const reloaded = await tab.page.evaluate(() => !window.beforeMove);
  return {
    reloaded,
    group: await groupOf(handle.lab, tab.page.url()),
    fetched: await whoAmI(tab.page),
    localStorage,
    events: (await handle.lab.events())
      .filter(({ type }) => /moved|synced|failed/.test(type))
      .slice(-8),
  };
}

async function closeRestore(handle, { admin }) {
  const url = admin.page.url();
  await handle.lab.closeTab(admin.tabId);
  const before = new Set(handle.context.pages());
  await handle.lab.restoreLast();
  await pause(1000);
  const page = handle.context.pages().find((candidate) => !before.has(candidate));
  const rendered = await settledUser(page);
  const events = (await handle.lab.events())
    .filter(({ type }) => /failed|missing|attached|synced|settled/.test(type))
    .slice(-8);
  return { rendered, fetched: await whoAmI(page), group: await groupOf(handle.lab, url), events };
}

/** After the extension's worker went away: the probes, a tab event to wake it, then the tab again. */
async function afterGap(handle, admin, startedAt) {
  const seen = await probes(admin.page);
  const lab = await nextLab(handle);
  await pause(1000);
  const after = await within(whoAmI(admin.page), 5000, "no answer in 5 s");
  await admin.page.reload();
  const afterPageReload = await homeUser(admin.page);
  const restarted = (await lab.startedAt()) !== startedAt;
  const events = (await lab.events())
    .filter(({ type }) => /failed|missing|attached|detached|synced/.test(type))
    .slice(0, 12);
  return { seen, restarted, after, afterPageReload, events };
}

/** Stops the extension's service worker as Chrome does after 30 seconds idle. */
async function workerStop(handle, { admin }) {
  const extensionPage = await handle.context.newPage();
  await extensionPage.goto(new URL("blank.html", handle.worker.url()).href);
  const cdp = await handle.context.newCDPSession(extensionPage);
  const startedAt = await handle.lab.startedAt();
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await extensionPage.close();
  return afterGap(handle, admin, startedAt);
}

/** Without developer mode, Chromium disables an unpacked extension that reloads itself. */
async function developerMode(context) {
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  await page.evaluate(() => {
    const toolbar = document
      .querySelector("extensions-manager")
      .shadowRoot.querySelector("extensions-toolbar");
    const toggle = toolbar.shadowRoot.querySelector("#devMode");
    if (!toggle.checked) toggle.click();
  });
  await page.close();
}

async function extensionReload(handle, { admin }) {
  await developerMode(handle.context);
  const startedAt = await handle.lab.startedAt();
  await handle.lab.reloadExtension();
  return afterGap(handle, admin, startedAt);
}

async function failures(lab) {
  return (await lab.events()).filter(({ type }) => /failed|missing/.test(type)).slice(0, 10);
}

/** Closes the browser and opens the same profile with its last session. */
async function restart(handle) {
  await handle.close({ keep: true });
  const reopened = await launchLab({ profile: handle.profile, args: ["--restore-last-session"] });
  try {
    await pause(2000);
    const tabs = await reopened.lab.tabs();
    const pages = reopened.context.pages().filter((page) => page.url().startsWith(APP));
    const users = [];
    for (const page of pages)
      users.push({ group: await groupOf(reopened.lab, page.url()), fetched: await whoAmI(page) });
    return { tabs, users, events: await failures(reopened.lab) };
  } finally {
    await reopened.close();
  }
}

const CASES = { ctrlClick, duplicate, move, closeRestore, workerStop, extensionReload, restart };

async function runCase(name) {
  const handle = await launchLab();
  try {
    const tabs = await setup(handle);
    return {
      case: name,
      chromium: handle.version,
      signedIn: tabs.signedIn,
      ...(await CASES[name](handle, tabs)),
    };
  } catch (error) {
    return { case: name, error: String(error).slice(0, 300) };
  } finally {
    await handle.close().catch(() => {});
  }
}

const fixture = await startFixture();
try {
  const names = process.argv.slice(2);
  const results = [];
  for (const name of names.length > 0 ? names : Object.keys(CASES))
    results.push(await runCase(name));
  console.log("evidence:", writeEvidence("lifecycle", results));
} finally {
  await fixture.close();
}
