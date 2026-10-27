// Experiment F: switching in an incognito window, with "Allow in Incognito" on. Incognito storage
// and cookies are apart from the normal window's; captures must be too, and must not outlive it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, SSO, startFixture } from "../fixture/server.mjs";
import {
  brief,
  launchLab,
  observed,
  openApp,
  openIncognito,
  sawIdentity,
  write,
  writeEvidence,
} from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

async function incognitoSession(settings = {}) {
  const session = await launchLab({ incognito: true });
  await session.lab.configure({ firstIdentity: "A", ...settings });
  return session;
}

const seen = async (page) => brief(await observed(page));

await test("F: storage switches in an incognito window and leaves the normal window alone", async () => {
  const session = await incognitoSession();
  try {
    const normal = await openApp(session);
    await write(normal.page, "normal-1");
    const hidden = await openIncognito(session, `${APP}/app?incognito=1`);
    await observed(hidden.page);
    await session.lab.manage(hidden.tabId);
    await write(hidden.page, "I-A");
    const steps = {};
    await session.lab.switchTo(hidden.tabId, "B");
    steps.b = await seen(hidden.page);
    await write(hidden.page, "I-B");
    await session.lab.switchTo(hidden.tabId, "A");
    steps.a = await seen(hidden.page);
    await normal.page.reload();
    steps.normal = await seen(normal.page);
    // The normal window's B is its own: it starts, and does not resume the incognito B.
    steps.normalToB = (await session.lab.switchTo(normal.tabId, "B")).kind;
    steps.normalB = await seen(normal.page);
    steps.captures = await session.lab.captures();
    evidence.storage = steps;
    console.log(JSON.stringify({ storage: steps }));
    assert.ok(sawIdentity(steps.b, null), "incognito B starts empty");
    assert.ok(sawIdentity(steps.a, "I-A"), "incognito A comes back");
    assert.ok(sawIdentity(steps.normal, "normal-1"), "the normal window kept its storage");
    assert.equal(steps.normalToB, "start");
    assert.ok(sawIdentity(steps.normalB, null), "the normal B starts empty");
    assert.deepEqual(steps.captures, ["A", "A (incognito)", "B (incognito)"]);
  } finally {
    await session.close();
  }
});

/** The login page, or the app's session once the silent sign-in settled. */
async function sessionOf(page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = await page
      .evaluate(() =>
        document.title === "SSO login" ? { login: true } : (window.__session ?? null),
      )
      .catch(() => null);
    if (found) return found;
    await page.waitForTimeout(100);
  }
  throw new Error(`no session or login page at ${page.url()}`);
}

async function signIn(page, user) {
  const back = encodeURIComponent(`${APP}/sso-app`);
  await page.goto(`${SSO}/realms/lab/login?user=${user}&return=${back}`);
  return sessionOf(page);
}

await test("F: the sign-in host's cookies switch in the incognito cookie store only", async () => {
  const session = await incognitoSession({ cookieHosts: ["sso.localhost"] });
  try {
    const normal = await session.context.newPage();
    await normal.goto(`${APP}/sso-app`);
    const steps = { normal: await signIn(normal, "carol") };
    const hidden = await openIncognito(session, `${APP}/sso-app`);
    steps.first = await sessionOf(hidden.page);
    steps.a = await signIn(hidden.page, "alice");
    await session.lab.manage(hidden.tabId);
    await session.lab.switchTo(hidden.tabId, "B");
    steps.b = await sessionOf(hidden.page);
    steps.bSignedIn = await signIn(hidden.page, "bob");
    await session.lab.switchTo(hidden.tabId, "A");
    steps.backToA = await sessionOf(hidden.page);
    await normal.reload();
    steps.normalAfter = await sessionOf(normal);
    evidence.cookies = steps;
    console.log(JSON.stringify({ cookies: steps }));
    assert.deepEqual(steps.first, { login: true }, "incognito starts without the normal session");
    assert.deepEqual(steps.b, { login: true });
    assert.deepEqual(steps.backToA, { user: "alice", profile: "alice" });
    assert.equal(steps.normalAfter.user, "carol", "the normal window's session is untouched");
  } finally {
    await session.close();
  }
});

await test("F: closing the last incognito window deletes its captures", async () => {
  const session = await incognitoSession();
  try {
    const normal = await openApp(session);
    await session.lab.switchTo(normal.tabId, "B");
    const hidden = await openIncognito(session, `${APP}/app?incognito=1`);
    await observed(hidden.page);
    await session.lab.manage(hidden.tabId);
    await session.lab.switchTo(hidden.tabId, "B");
    const before = await session.lab.captures();
    await session.worker.evaluate(async () => {
      const windows = await chrome.windows.getAll();
      await Promise.all(
        windows.filter((each) => each.incognito).map((each) => chrome.windows.remove(each.id)),
      );
    });
    let after = before;
    for (let attempt = 0; attempt < 50 && after.length === before.length; attempt += 1) {
      await normal.page.waitForTimeout(100);
      after = await session.lab.captures();
    }
    evidence.purge = { before, after };
    console.log(JSON.stringify({ purge: evidence.purge }));
    assert.deepEqual(before, ["A", "A (incognito)"]);
    assert.deepEqual(after, ["A"]);
  } finally {
    await session.close();
  }
});

await fixture.close();
writeEvidence("experiment-f", evidence);
