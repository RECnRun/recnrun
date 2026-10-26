// The purchase-order flow A → B → A → C → A in one tab, three rounds in one browser: the same
// tab, a new document per switch, no second sign-in for anyone, the backend's changes visible to
// whoever resumes, and every request carrying the active identity's session.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lab from "./harness.mjs";

const PROFILE_COOKIE = "profile=real-chrome-jar";

const handle = await lab.launchSingleTab();
const rounds = [];

/** One identity's turn: switch (and sign in once), then act on the order and read it. */
async function turn(identity, id, action) {
  const since = Date.now();
  const nonce = `${identity}-${since}`;
  const before = {
    nonce: await lab.readNonce(handle.page),
    origin: await lab.timeOrigin(handle.page),
  };
  const receipt = await lab.activate(handle, identity, { url: lab.orderUrl(id) });
  const document = {
    nonce: await lab.readNonce(handle.page),
    origin: await lab.timeOrigin(handle.page),
  };
  let signedIn;
  if ((await lab.readOrder(handle.page)).user === "signed out") {
    signedIn = await lab.signIn(handle, lab.USERS[identity]);
    await handle.page.goto(lab.orderUrl(id));
  }
  const result = action ? await lab.doStep(handle.page, action) : undefined;
  const order = await lab.readOrder(handle.page);
  await lab.plantNonce(handle.page, nonce);
  const requests = lab.requestsSince(handle, since);
  return { identity, receipt, before, document, signedIn, result, order, requests, nonce };
}

async function round(number) {
  const id = lab.orderId(`round${number}`);
  const turns = [
    await turn("A", id, "create"),
    await turn("B", id, "submit"),
    await turn("A", id),
    await turn("C", id, "approve"),
    await turn("A", id),
  ];
  rounds.push({ id, turns });
  return turns;
}

await test("three rounds keep one tab, one document per switch, and one sign-in per user", async (t) => {
  t.after(async () => {
    lab.writeEvidence("single-tab-flow", { chromium: handle.version, rounds });
    await handle.close();
  });
  // The profile's own jar has a cookie for the app; no managed request may carry it.
  await handle.lab.setRealCookie({ url: `${lab.APP}/`, name: "profile", value: "real-chrome-jar" });
  for (let number = 1; number <= 3; number += 1) {
    const turns = await round(number);
    const states = turns.map(({ order }) => order.state);
    assert.deepEqual(states, ["created", "submitted", "submitted", "approved", "approved"]);
    assert.deepEqual(
      turns.map(({ order }) => order.user),
      ["Admin", "Requester", "Admin", "Approver", "Admin"],
    );
    for (const { receipt } of turns) assert.equal(receipt.tabId, handle.tabId);
    assert.equal((await lab.appTabs(handle)).length, 1);
  }
  const all = rounds.flatMap(({ turns }) => turns);
  // Sign-ins: each user once, in round 1; A resumed 8 times without one.
  assert.deepEqual(
    all.map(({ signedIn }) => signedIn),
    ["Admin", "Requester", undefined, "Approver", undefined, ...Array(10).fill(undefined)],
  );
  for (const user of Object.values(lab.USERS)) assert.equal(lab.loginsOf(handle, user), 1);
  // New documents: distinct ids from webNavigation, the planted nonce gone, a new time origin.
  const documentIds = all.flatMap(({ receipt }) => [
    receipt.neutral.documentId,
    receipt.document.documentId,
  ]);
  assert.equal(new Set(documentIds).size, documentIds.length);
  for (const { before, document } of all.slice(1)) {
    assert.notEqual(before.nonce, null);
    assert.equal(document.nonce, null);
    assert.notEqual(document.origin, before.origin);
  }
  assert.equal((await handle.lab.commits(handle.tabId)).length >= 2 * all.length, true);
  // Every request of a turn carried that identity's session, or none before its sign-in.
  for (const { identity, requests } of all) {
    const users = new Set(requests.map(({ user }) => user));
    users.delete(null);
    assert.deepEqual([...users], [lab.USERS[identity]], `requests of ${identity}`);
    assert.equal(
      requests.some(({ cookie }) => cookie.includes(PROFILE_COOKIE)),
      false,
    );
  }
  const real = await handle.lab.realCookies();
  assert.deepEqual(real.map(({ name }) => name).toSorted(), ["profile"]);
  assert.deepEqual(await lab.eventsMatching(handle, /switch-failed|session-lost/), []);
});
