// Suspend, resume, and reset against every page API: each identity finds its own markers again,
// sessionStorage survives the neutral navigation, an HttpOnly session stays out of document.cookie
// but on the network, and a reset of B leaves A and C untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lab from "./harness.mjs";

const FIELDS = ["localStorage", "sessionStorage", "cookie", "indexedDB", "cache", "opfs"];
const markersOf = (read) => Object.fromEntries(FIELDS.map((field) => [field, read[field]]));
const expected = (marker) => Object.fromEntries(FIELDS.map((field) => [field, marker]));

const handle = await lab.launchSingleTab();
const evidence = {};

async function start(identity) {
  await lab.activate(handle, identity, { url: lab.apisUrl });
  await lab.signIn(handle, lab.USERS[identity]);
  await handle.page.goto(lab.apisUrl);
  await lab.writeMarkers(handle.page, identity);
  return lab.readMarkers(handle.page);
}

async function resume(identity, options) {
  await lab.activate(handle, identity, { url: lab.apisUrl, ...options });
  const read = await lab.readMarkers(handle.page);
  return { read, user: await lab.whoAmI(handle.page) };
}

/** Each identity's markers, written in its own first document: the HttpOnly session never shows. */
async function assertWritten(written) {
  for (const [identity, read] of Object.entries(written)) {
    assert.deepEqual(markersOf(read), expected(identity));
    // The session cookie is HttpOnly: the page never sees it, the network always does.
    assert.equal(read.cookie, identity);
    assert.equal(/(^|; )sid=/.test(await handle.page.evaluate(() => document.cookie)), false);
    assert.equal(read.cookieStore, false);
  }
}

function assertResumed({ read, user }, identity) {
  assert.deepEqual(markersOf(read), expected(identity));
  assert.equal(user, lab.USERS[identity]);
}

await test("storage per identity across suspend, resume, and reset", async (t) => {
  t.after(async () => {
    lab.writeEvidence("single-tab-storage", { chromium: handle.version, ...evidence });
    await handle.close();
  });

  await t.test(
    "A, B, and C each resume their own markers; a reset of B empties only B",
    async () => {
      evidence.written = { A: await start("A"), B: await start("B"), C: await start("C") };
      await assertWritten(evidence.written);
      const resumedA = await resume("A");
      assertResumed(resumedA, "A");
      // The lock A's first document held died with that document.
      assert.deepEqual(resumedA.read.heldLocks, []);
      const resumedB = await resume("B");
      assertResumed(resumedB, "B");
      const resetB = await resume("B", { reset: true });
      assert.deepEqual(markersOf(resetB.read), expected(null));
      assert.equal(resetB.user, null);
      assert.deepEqual(resetB.read.localKeys, []);
      assert.deepEqual(resetB.read.cacheKeys, []);
      const afterReset = { A: await resume("A"), C: await resume("C") };
      assertResumed(afterReset.A, "A");
      assertResumed(afterReset.C, "C");
      evidence.resumed = { resumedA, resumedB, resetB, afterReset };
      evidence.sessions = await handle.lab.sessions();
      const containers = evidence.sessions.identities.map(({ container }) => container);
      assert.deepEqual(containers, ["a", "b.2", "c"]);
      assert.deepEqual(await handle.lab.jar("b"), []);
      assert.equal(lab.loginsOf(handle, "Admin"), 1);
      // The real jar never received a session or a marker.
      assert.deepEqual(await handle.lab.realCookies(), []);
    },
  );

  await t.test("sessionStorage written after a resume is there after the next resume", async () => {
    await lab.activate(handle, "A", { url: lab.apisUrl });
    await handle.page.evaluate(() => sessionStorage.setItem("after-resume", "A2"));
    await lab.activate(handle, "C", { url: lab.apisUrl });
    const seenByC = await handle.page.evaluate(() => sessionStorage.getItem("after-resume"));
    await lab.activate(handle, "A", { url: lab.apisUrl });
    const seenByA = await handle.page.evaluate(() => sessionStorage.getItem("after-resume"));
    evidence.sessionStorage = { seenByC, seenByA };
    assert.equal(seenByC, null);
    assert.equal(seenByA, "A2");
  });
});
