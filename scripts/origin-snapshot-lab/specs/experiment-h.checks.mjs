// Experiment H: an app's service worker that keeps an IndexedDB connection open (Gmail's keeps
// gmail-sw-keyval) blocks every switch (Experiment B). Here the lab removes the origin's service
// worker registration before the probe, which stops the worker, and the app registers it again.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import {
  brief,
  launchLab,
  observed,
  openApp,
  openIncognito,
  sawIdentity,
  write,
  writeEvidence,
  writeUnpacked,
} from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();
const PATH = "/app?sw=1&swhold=1";

const rec = (worker, command, ...args) =>
  worker.evaluate(([name, values]) => globalThis.rec[name](...values), [command, args]);

/** Writes `marker`, then reloads so the service worker holds the database it is in. */
async function writeHeld(page, marker) {
  await write(page, marker);
  await page.reload();
  await observed(page);
  await page.waitForTimeout(500);
}

const registered = (page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state);

/** A switch through `rec`, as the worker's console runs it; the error's text if it fails. */
const attempt = (worker, to) =>
  rec(worker, "switch", to).catch((error) => String(error.message ?? error));

for (const forceClear of [false, true]) {
  await test(`H: service worker holding app-db, forceClear ${forceClear}`, async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "recnrun-origin-lab-unpacked-")), "unpacked");
    writeUnpacked({ url: `${APP}${PATH}`, cookieHosts: [], forceClear }, dir);
    const session = await launchLab({ extension: dir });
    const steps = {};
    evidence[`forceClear ${forceClear}`] = steps;
    try {
      const app = await openApp(session, PATH);
      await rec(session.worker, "start");
      await writeHeld(app.page, "A-1");
      steps.toB = await attempt(session.worker, "B");
      if (!forceClear) {
        assert.match(steps.toB, /exclusive access to app-db .*nothing changed/);
        return;
      }
      steps.b = brief(await observed(app.page));
      steps.swAfterB = await registered(app.page);
      await writeHeld(app.page, "B-1");
      steps.toA = await attempt(session.worker, "A");
      steps.a = brief(await observed(app.page));
      steps.swAfterA = await registered(app.page);
      assert.equal(steps.toB.kind, "start");
      assert.ok(sawIdentity(steps.b, null), "B starts empty");
      assert.equal(steps.toA.kind, "resume");
      assert.ok(sawIdentity(steps.a, "A-1"), "A comes back");
      // The app registered its service worker again after each switch.
      assert.equal(steps.swAfterB, "activated");
      assert.equal(steps.swAfterA, "activated");
    } finally {
      console.log(JSON.stringify({ forceClear, steps }));
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

await test("H: forceClear refuses in incognito, where it is untested", async () => {
  const session = await launchLab({ incognito: true });
  try {
    await session.lab.configure({ firstIdentity: "A", forceClear: true });
    const hidden = await openIncognito(session, `${APP}/app?incognito=1`);
    await observed(hidden.page);
    await write(hidden.page, "I-A");
    const outcome = await session.lab
      .switchTo(hidden.tabId, "B")
      .then(() => "switched")
      .catch((error) => String(error.message ?? error));
    const after = brief(await observed(hidden.page));
    evidence.incognito = { outcome, after };
    console.log(JSON.stringify({ incognito: evidence.incognito }));
    assert.match(
      outcome,
      /forceClear is untested in incognito \(nothing changed; the tabs are back\)/,
    );
    assert.ok(sawIdentity(after, "I-A"), "the incognito tab still holds A");
  } finally {
    await session.close();
  }
});

await fixture.close();
writeEvidence("experiment-h", evidence);
