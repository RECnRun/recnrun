// Experiment B: open connections and concurrent writers during a switch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import { launchLab, observed, openApp, writeEvidence, write } from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

const attempt = (promise) =>
  promise.then(
    (receipt) => ({ ok: true, ms: receipt.ms, cleared: receipt.report?.cleared }),
    (error) => ({ ok: false, error: String(error?.message ?? error) }),
  );

/** A writes A-1 and B starts: the switch whose clearing meets the holder. */
async function switchWithHolder(session, path) {
  const { page, tabId } = await openApp(session, path);
  await session.lab.switchTo(tabId, "A");
  await write(page, "A-1");
  // Reload so the flag's holder (connection, worker, service worker) starts on the existing db.
  await page.reload();
  await observed(page);
  if (path.includes("sw")) await page.waitForTimeout(500);
  return { page, tabId, outcome: await attempt(session.lab.switchTo(tabId, "B")) };
}

for (const [name, path] of [
  ["the app's own connection", "/app?conn=1"],
  ["a dedicated worker's connection", "/app?worker=1"],
  ["a shared worker's connection", "/app?shared=1"],
  ["a service worker's connection", "/app?sw=1&swhold=1"],
]) {
  await test(`holder: ${name}`, async () => {
    const session = await launchLab({ bfcache: true });
    await session.lab.configure({ clear: { timeoutMs: 3000, probe: false }, timeoutMs: 10000 });
    try {
      const { outcome } = await switchWithHolder(session, path);
      evidence[`holder ${name}`] = outcome;
      console.log(JSON.stringify({ name, outcome }));
    } finally {
      await session.close();
    }
  });
}

/** What a fresh document of the origin sees once the second tab is gone. */
async function afterHolderLeaves(session, holder) {
  await holder.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const page = await session.context.newPage();
  await page.goto(`${APP}/app?check=1`);
  return (await observed(page)).idb;
}

for (const probe of [false, true]) {
  await test(`second tab holding app-db; exclusive probe ${probe}`, async () => {
    const session = await launchLab({ bfcache: true });
    await session.lab.configure({ clear: { timeoutMs: 2000, probe }, timeoutMs: 8000 });
    try {
      const { page, tabId } = await openApp(session);
      await session.lab.switchTo(tabId, "A");
      await write(page, "A-1");
      const holder = await session.context.newPage();
      await holder.goto(`${APP}/app?conn=1`);
      await holder.waitForFunction(() => window.app?.held());
      const outcome = await attempt(session.lab.switchTo(tabId, "B"));
      const captureOfA = await session.lab.capture(new URL(APP).origin, "A");
      const later = await afterHolderLeaves(session, holder);
      evidence[`second tab, probe ${probe}`] = { outcome, captureOfA, later };
      console.log(JSON.stringify({ probe, outcome, later }));
      assert.equal(outcome.ok, false, "the switch must not succeed while another tab holds app-db");
      assert.ok(captureOfA, "A was persisted before anything was cleared");
      if (probe) assert.equal(later?.marker, "A-1", "nothing was deleted after the failure");
    } finally {
      await session.close();
    }
  });
}

await test("service worker writing on every navigation: where its writes land", async () => {
  const session = await launchLab({ bfcache: true });
  try {
    const { page, tabId } = await openApp(session, "/app?sw=1");
    await page.waitForTimeout(500);
    const turns = [];
    for (let index = 0; index < 20; index += 1) {
      const who = index % 2 === 0 ? "A" : "B";
      const receipt = await attempt(
        session.lab.switchTo(tabId, who, { url: `${APP}/app?sw=1&who=${who}` }),
      );
      await observed(page);
      const log = await page.evaluate(readSwLog);
      turns.push({ who, ok: receipt.ok, error: receipt.error, log });
    }
    const leaks = turns.map(({ who, log }) => ({
      who,
      foreign: log.filter((url) => url.includes("who=") && !url.includes(`who=${who}`)).length,
      gate: log.filter((url) => url.includes("__recnrun_gate")).length,
      own: log.filter((url) => url.includes(`who=${who}`)).length,
    }));
    evidence.serviceWorkerWrites = { failures: turns.filter((turn) => !turn.ok), leaks };
    console.log(
      JSON.stringify({ failures: turns.filter((turn) => !turn.ok).length, last: leaks.slice(-2) }),
    );
    assert.equal(
      leaks.reduce((sum, leak) => sum + leak.foreign, 0),
      0,
    );
  } finally {
    await session.close();
  }
});

/** Runs in the page, as the app would: the URLs its service worker logged in sw-db. */
function readSwLog() {
  return new Promise((resolve) => {
    const request = indexedDB.open("sw-db");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("log").objectStore("log").getAll();
      read.onsuccess = () => {
        db.close();
        resolve(read.result.map((entry) => entry.url));
      };
    };
  });
}

await fixture.close();
writeEvidence("experiment-b", evidence);
