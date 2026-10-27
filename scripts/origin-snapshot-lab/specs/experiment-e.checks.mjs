// Experiment E: every tab of the origin in the lead tab's RECnRun group switches with it; a tab of
// the origin outside the group shares its storage, so it refuses the switch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import { brief, launchLab, observed, openApp, sawIdentity, write, writeEvidence } from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

/** Opens `url` in a new window, as a user would by hand: no app tab opened it. */
async function openWindow({ context, worker, lab }, url) {
  const next = context.waitForEvent("page");
  await worker.evaluate((address) => chrome.windows.create({ url: address }), url);
  const page = await next;
  await observed(page);
  return { page, tabId: await lab.tabIdFor(page.url()) };
}

async function managedSession() {
  const session = await launchLab();
  await session.lab.configure({ firstIdentity: "A", clear: { timeoutMs: 5000, probe: true } });
  const app = await openApp(session);
  await session.lab.manage(app.tabId);
  await write(app.page, "A-1");
  return { session, app };
}

/** Clicks `selector` in the app, which opens a tab, and returns that tab's page and id. */
async function opened({ session, app }, selector) {
  const next = session.context.waitForEvent("page");
  await app.page.click(selector);
  const page = await next;
  await observed(page);
  return { page, tabId: await session.lab.tabIdFor(page.url()) };
}

/** sessionStorage is per tab: each tab gets its own marker under `identity`. */
const markTabs = (tabs, identity) =>
  Promise.all(
    tabs.map(({ page }, index) =>
      page.evaluate((value) => sessionStorage.setItem("marker", value), `${identity}-tab${index}`),
    ),
  );

/** Whether every tab saw `marker` in shared storage and its own tab marker, or none, in its own. */
async function seenByTabs(tabs, marker, identity) {
  const seen = await Promise.all(tabs.map(async ({ page }) => brief(await observed(page))));
  const ok = seen.every((each, index) => {
    const shared = marker === null ? each.idb?.missing === true : each.idb?.marker === marker;
    const own = identity === null ? null : `${identity}-tab${index}`;
    return each.ls === marker && shared && each.ss === own;
  });
  return { seen, ok };
}

await test("E: tabs the app opens join the group, and the whole group switches", async () => {
  const run = await managedSession();
  const { session, app } = run;
  try {
    const link = await opened(run, "#link");
    // The popup holds an IndexedDB connection, which blocked the switch in Experiment B.
    const popup = await opened(run, "#popup");
    const tabs = [app, link, popup];
    const groups = await Promise.all(tabs.map(({ tabId }) => session.lab.groupOf(tabId)));
    const steps = { groups };
    assert.equal(new Set(groups.map((group) => group?.id)).size, 1, "the tabs share one group");
    assert.notEqual(groups[0], null);

    await markTabs(tabs, "A");
    const toB = await session.lab.switchTo(app.tabId, "B");
    steps.toB = { tabs: toB.tabs, ...(await seenByTabs(tabs, null, null)) };
    await write(link.page, "B-1");
    await markTabs(tabs, "B");
    // Each switch leads from another tab: the per-tab storage must follow the tab, not the lead.
    const toA = await session.lab.switchTo(link.tabId, "A");
    steps.toA = { tabs: toA.tabs, ...(await seenByTabs(tabs, "A-1", "A")) };
    await session.lab.switchTo(popup.tabId, "B");
    steps.backToB = await seenByTabs(tabs, "B-1", "B");
    steps.title = (await session.lab.groupOf(app.tabId)).title;
    steps.groupedBy = (await session.lab.events())
      .filter((event) => event.step === "tab created")
      .map((event) => event.groupedBy);
    evidence.group = steps;
    console.log(JSON.stringify({ group: steps }));
    assert.ok(steps.toB.ok && steps.toA.ok && steps.backToB.ok, "every tab saw the identity");
    assert.equal(steps.toB.tabs, 3);
    // Every tab came back at its own URL, whichever tab led the switch.
    const urls = tabs.map(({ page }) => page.url());
    for (const step of [steps.toB, steps.toA, steps.backToB]) {
      assert.deepEqual(
        step.seen.map((each) => each.href),
        urls,
      );
    }
    assert.equal(steps.title, "RECnRun · B");
  } finally {
    await session.close();
  }
});

await test("E: a tab of the origin outside the group refuses the switch", async () => {
  const { session, app } = await managedSession();
  try {
    const outsider = await openWindow(session, `${APP}/app?outside=1`);
    const outcome = await session.lab
      .switchTo(app.tabId, "B")
      .then(() => "switched")
      .catch((error) => String(error.message ?? error));
    await app.page.reload();
    // The outsider's window started its own sessionStorage, so only the app tab holds A's there.
    const after = await seenByTabs([app, outsider], "A-1", null);
    const captures = await session.lab.captures();
    evidence.outsider = { outcome, after, captures };
    console.log(JSON.stringify({ outsider: evidence.outsider }));
    assert.match(outcome, /outside the RECnRun group: \/app/);
    assert.ok(sawIdentity(after.seen[0], "A-1"), "the app tab still holds A");
    assert.equal(after.seen[1].ls, "A-1", "the outsider still holds A");
    assert.equal(after.seen[1].idb?.marker, "A-1");
    assert.deepEqual(captures, []);
  } finally {
    await session.close();
  }
});

await fixture.close();
writeEvidence("experiment-e", evidence);
