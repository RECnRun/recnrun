// Experiment G: the lab in the person's own Chrome, driven from the service worker's console. There
// the worker stops when idle and starts again with empty memory, which Playwright's runs never saw.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import {
  launchLab,
  observed,
  openApp,
  restartExtension as restart,
  sawIdentity,
  signIn,
  ssoSession,
  write,
  writeEvidence,
  writeUnpacked,
} from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

await test("G: after the worker restarts, a switch refuses instead of guessing the identity", async () => {
  const session = await launchLab();
  try {
    await session.lab.configure({ firstIdentity: "A" });
    const app = await openApp(session);
    await write(app.page, "A-1");
    await session.lab.switchTo(app.tabId, "B");
    await write(app.page, "B-1");
    const { lab } = await restart(session);
    await lab.register(APP);
    await lab.configure({ firstIdentity: "A" });
    const outcome = await lab
      .switchTo(app.tabId, "A")
      .then((receipt) => receipt.kind)
      .catch((error) => String(error.message ?? error));
    await app.page.reload();
    const after = await observed(app.page);
    const captures = await lab.captures();
    evidence.restart = { outcome, captures };
    console.log(JSON.stringify({ restart: evidence.restart }));
    assert.match(outcome, /lost track of http:\/\/app\.localhost:4330's identity/);
    assert.ok(sawIdentity(after, "B-1"), "the tab still holds B");
    assert.deepEqual(captures, ["A"]);
  } finally {
    await session.close();
  }
});

const rec = (worker, command, ...args) =>
  worker.evaluate(([name, values]) => globalThis.rec[name](...values), [command, args]);

await test("G: preset.json configures the lab at every start, and rec switches the group", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recnrun-origin-lab-unpacked-")), "unpacked");
  writeUnpacked({ url: `${APP}/sso-app`, cookieHosts: ["sso.localhost"] }, dir);
  const session = await launchLab({ extension: dir });
  const steps = {};
  evidence.preset = steps;
  try {
    const page = await session.context.newPage();
    await page.goto(`${APP}/sso-app`);
    steps.a = await signIn(page, "alice");
    steps.start = await rec(session.worker, "start");
    steps.toB = await rec(session.worker, "switch", "B");
    steps.b = await ssoSession(page);
    steps.bSignedIn = await signIn(page, "bob");
    steps.toA = await rec(session.worker, "switch", "A");
    steps.backToA = await ssoSession(page);
    // A restart re-applies the preset and refuses, rather than starting over as the first identity.
    const { worker } = await restart(session);
    steps.afterRestart = await rec(worker, "switch", "B").catch((error) => String(error.message));
    assert.equal(steps.start, "RECnRun · A");
    assert.deepEqual(steps.b, { login: true });
    assert.deepEqual(steps.backToA, { user: "alice", profile: "alice" });
    assert.equal(steps.toB.tabs, 1);
    assert.deepEqual(steps.toA.cookies, { removed: 1, set: 1, expired: 0 });
    assert.match(steps.afterRestart, /lost track/);
  } finally {
    console.log(JSON.stringify({ preset: steps }));
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("G: a tab joins a group while a window that is not normal has focus", async () => {
  const session = await launchLab();
  try {
    const app = await openApp(session);
    // The worker's DevTools is such a window: for the worker it is the current one.
    await session.worker.evaluate(() =>
      chrome.windows.create({ type: "popup", url: "about:blank", focused: true }),
    );
    const outcome = await session.lab
      .manage(app.tabId)
      .then(() => "grouped")
      .catch((error) => String(error.message ?? error));
    const group = await session.lab.groupOf(app.tabId);
    evidence.focus = { outcome, group };
    console.log(JSON.stringify({ focus: evidence.focus }));
    assert.equal(outcome, "grouped");
    assert.equal(group?.title, "RECnRun · profile");
  } finally {
    await session.close();
  }
});

const cookieNames = (worker) =>
  worker.evaluate(async () =>
    (await chrome.cookies.getAll({ domain: "app.localhost" })).map((cookie) => cookie.name),
  );

// Gmail's service worker keeps an IndexedDB connection open, so the probe refuses the switch.
await test("G: a switch the probe refuses changes nothing, cookies included", async () => {
  const session = await launchLab();
  try {
    await session.lab.configure({
      firstIdentity: "A",
      cookieHosts: ["app.localhost"],
      clear: { timeoutMs: 2000, probe: true },
      timeoutMs: 10000,
    });
    const app = await openApp(session, "/app?sw=1&swhold=1");
    await write(app.page, "A-1");
    await app.page.evaluate(() => (document.cookie = "who=A; max-age=3600"));
    // Reload so the service worker starts holding the existing database.
    await app.page.reload();
    await observed(app.page);
    await app.page.waitForTimeout(500);
    const attempt = () =>
      session.lab
        .switchTo(app.tabId, "B")
        .then(() => "switched")
        .catch((error) => String(error.message ?? error));
    const steps = { first: await attempt() };
    // The probe's open stays queued behind the holder, so the app's own opens of app-db wait
    // too: look without opening it.
    steps.after = await app.page.evaluate(async () => ({
      href: location.href,
      ls: localStorage.getItem("marker"),
      databases: (await indexedDB.databases()).map(({ name, version }) => `${name}@${version}`),
    }));
    steps.cookies = await cookieNames(session.worker);
    // The identity is still A, so a retry meets the probe again rather than an unknown state.
    steps.retry = await attempt();
    evidence.refused = steps;
    console.log(JSON.stringify({ refused: evidence.refused }));
    assert.match(steps.first, /exclusive access to app-db .*nothing changed; the tabs are back/);
    assert.deepEqual(steps.after, {
      href: `${APP}/app?sw=1&swhold=1`,
      ls: "A-1",
      databases: ["app-db@1", "sw-db@1"],
    });
    assert.deepEqual(steps.cookies, ["who"]);
    assert.match(steps.retry, /nothing changed/);
  } finally {
    await session.close();
  }
});

await test("G: rec.restoreCookies puts an identity's captured cookies back", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "recnrun-origin-lab-unpacked-")), "unpacked");
  writeUnpacked({ url: `${APP}/sso-app`, cookieHosts: ["sso.localhost"] }, dir);
  const session = await launchLab({ extension: dir });
  const steps = {};
  try {
    const page = await session.context.newPage();
    await page.goto(`${APP}/sso-app`);
    steps.a = await signIn(page, "alice");
    await rec(session.worker, "start");
    await rec(session.worker, "switch", "B");
    steps.b = await ssoSession(page);
    steps.restored = await rec(session.worker, "restoreCookies", "A");
    await page.reload();
    steps.after = await ssoSession(page);
    evidence.restoreCookies = steps;
    console.log(JSON.stringify({ restoreCookies: steps }));
    assert.deepEqual(steps.b, { login: true });
    assert.deepEqual(steps.restored, { removed: 0, set: 1, expired: 0 });
    assert.equal(steps.after.user, "alice", "the sign-in host's session is A's again");
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await fixture.close();
writeEvidence("experiment-g", evidence);
