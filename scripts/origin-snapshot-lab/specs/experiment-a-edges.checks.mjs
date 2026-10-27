// Experiment A, edges: the offscreen frame (A3), the history a switch leaves, and beforeunload.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import { brief, launchLab, observed, openApp, writeEvidence, write } from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();
let session;

await test("A3: a frame of the origin in an offscreen document sees the top-level storage", async () => {
  session = await launchLab();
  try {
    const { page } = await openApp(session);
    await write(page, "top-level");
    const probe = await session.lab.probeOffscreen(`${APP}/app`);
    evidence.a3 = probe;
    console.log(JSON.stringify(probe));
    assert.ok(!probe.timeout, "the offscreen frame never reported");
    // The finding is recorded either way; a partitioned frame sees none of the top-level's data.
    evidence.a3Partitioned = !probe.summary.local.includes("marker");
  } finally {
    await session.close();
  }
});

/** Where Back and Forward land after A → B, and what the documents there see. */
async function history(page) {
  const steps = [];
  const record = async (label) => {
    const url = page.url();
    const app = url.startsWith(APP) && !url.includes("__recnrun_gate");
    const seen = app ? brief(await observed(page)) : null;
    const document = app ? await page.evaluate(() => window.__observed.document) : null;
    const navigation = await page.evaluate(
      () => performance.getEntriesByType("navigation")[0]?.type,
    );
    steps.push({ label, url, document, navigation, seen });
  };
  await record("after A → B");
  for (const label of ["back 1", "back 2", "back 3"]) {
    await page.goBack({ waitUntil: "commit" }).catch(() => undefined);
    await page.waitForTimeout(500);
    await record(label);
  }
  return steps;
}

for (const [bfcache, replace] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  await test(`history after a switch: Back from B, bfcache ${bfcache}, replace ${replace}`, async () => {
    session = await launchLab({ bfcache });
    await session.lab.configure({ replace });
    try {
      const { page, tabId } = await openApp(session);
      // Control: a plain navigation and Back, without a switch, restores from bfcache when on.
      const before = await page.evaluate(() => window.__observed.document);
      await page.goto(`${APP}/app?control=1`);
      await page.goBack({ waitUntil: "commit" });
      const control = (await observed(page)).document === before;
      await session.lab.switchTo(tabId, "A");
      await write(page, "A-1");
      const documentA = await page.evaluate(() => window.__observed.document);
      await session.lab.switchTo(tabId, "B");
      await write(page, "B-1");
      const steps = await history(page);
      const resurrected = steps.some((step) => step.document === documentA);
      evidence[`history-bfcache-${bfcache}-replace-${replace}`] = {
        control,
        documentA,
        resurrected,
        steps,
      };
      console.log(
        JSON.stringify({
          bfcache,
          replace,
          control,
          resurrected,
          steps: steps.map((step) => [
            step.label,
            step.navigation,
            step.document === documentA,
            step.seen?.ls,
          ]),
        }),
      );
    } finally {
      await session.close();
    }
  });
}

await test("beforeunload: a page that asks before leaving", async () => {
  session = await launchLab();
  try {
    const { page, tabId } = await openApp(session, "/app?beforeunload=1");
    await write(page, "A-0");
    await page.click("h1");
    const dialogs = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.accept();
    });
    await session.lab.configure({ timeoutMs: 5000 });
    const outcome = await session.lab
      .switchTo(tabId, "A")
      .then((receipt) => ({ ok: true, ms: receipt.ms }))
      .catch((error) => ({ ok: false, error: String(error.message ?? error) }));
    evidence.beforeunload = { outcome, dialogs };
    console.log(JSON.stringify(evidence.beforeunload));
  } finally {
    await session.close();
  }
});

await fixture.close();
writeEvidence("experiment-a-edges", evidence);
