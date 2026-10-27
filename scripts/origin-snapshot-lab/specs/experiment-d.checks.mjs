// Experiment D: an app signed in through a sign-in server on another host, whose session cookie
// the origin's snapshot does not hold unless the extension swaps that host's cookies too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP, startFixture } from "../fixture/server.mjs";
import { launchLab, signIn, ssoSession as sessionOf, writeEvidence } from "../lab.mjs";

const evidence = {};
// Top-level awaited tests do not wait for root before()/after() hooks; the module owns it.
const fixture = await startFixture();

/** Signs in alice as A, switches to B (signing in bob if asked), back to A, and to B again. */
async function scenario(cookieHosts) {
  const session = await launchLab();
  try {
    await session.lab.configure({ cookieHosts, firstIdentity: "A" });
    const page = await session.context.newPage();
    await page.goto(`${APP}/sso-app`);
    const steps = { first: await sessionOf(page), a: await signIn(page, "alice") };
    const tabId = await session.lab.tabIdFor(`${APP}/`);
    const switches = [];
    for (const [label, to] of [
      ["b", "B"],
      ["backToA", "A"],
      ["backToB", "B"],
    ]) {
      const receipt = await session.lab.switchTo(tabId, to);
      switches.push({ to, kind: receipt.kind, cookies: receipt.report.cookies });
      steps[label] = await sessionOf(page);
      if (steps[label].login) steps[`${label}SignedIn`] = await signIn(page, "bob");
    }
    return { steps, switches };
  } finally {
    await session.close();
  }
}

await test("D control: without the sign-in host's cookies, B is silently signed in as A", async () => {
  const result = await scenario([]);
  evidence.control = result;
  console.log(JSON.stringify({ control: result.steps }));
  assert.deepEqual(result.steps.first, { login: true });
  assert.deepEqual(result.steps.b, { user: "alice", profile: null });
});

await test("D: with the sign-in host's cookies, each identity keeps its own session", async () => {
  const result = await scenario(["sso.localhost"]);
  evidence.withCookies = result;
  console.log(JSON.stringify({ withCookies: result }));
  assert.deepEqual(result.steps.b, { login: true });
  assert.deepEqual(result.steps.bSignedIn, { user: "bob", profile: null });
  assert.deepEqual(result.steps.backToA, { user: "alice", profile: "alice" });
  assert.deepEqual(result.steps.backToB, { user: "bob", profile: "bob" });
  assert.deepEqual(
    result.switches.map((step) => step.cookies),
    [
      { removed: 1, set: 0, expired: 0 },
      { removed: 1, set: 1, expired: 0 },
      { removed: 1, set: 1, expired: 0 },
    ],
  );
});

// A parent domain as the cookie host (google.com for mail.google.com) covers the origin itself.
for (const cookieHost of ["sso.localhost", "localhost"]) {
  await test(`D: a group tab left on the sign-in page switches with the group, ${cookieHost}`, () =>
    signInTabScenario(cookieHost));
}

async function signInTabScenario(cookieHost) {
  const session = await launchLab();
  const steps = {};
  evidence[`signInTab ${cookieHost}`] = steps;
  try {
    await session.lab.configure({ cookieHosts: [cookieHost], firstIdentity: "A" });
    const lead = await session.context.newPage();
    await lead.goto(`${APP}/sso-app`);
    steps.a = await signIn(lead, "alice");
    const tabId = await session.lab.tabIdFor(`${APP}/`);
    await session.lab.manage(tabId);
    const next = session.context.waitForEvent("page");
    await lead.evaluate((url) => window.open(url, "_blank"), `${APP}/sso-app?tab=2`);
    const mate = await next;
    steps.mateA = await sessionOf(mate);
    steps.toB = (await session.lab.switchTo(tabId, "B")).tabs;
    steps.b = [await sessionOf(lead), await sessionOf(mate)];
    // The person signs in on one tab; the other is left on the sign-in page.
    steps.bSignedIn = await signIn(lead, "bob");
    steps.toA = await session.lab
      .switchTo(tabId, "A")
      .then((receipt) => receipt.tabs)
      .catch((error) => String(error.message ?? error));
    steps.backToA = [await sessionOf(lead), await sessionOf(mate)];
    await session.lab.switchTo(tabId, "B");
    steps.backToB = [await sessionOf(lead), await sessionOf(mate)];
    assert.deepEqual(steps.b, [{ login: true }, { login: true }]);
    assert.equal(steps.toA, 2);
    assert.deepEqual(steps.backToA, [
      { user: "alice", profile: "alice" },
      { user: "alice", profile: "alice" },
    ]);
    assert.deepEqual(steps.backToB, [
      { user: "bob", profile: "bob" },
      { user: "bob", profile: "bob" },
    ]);
  } finally {
    console.log(JSON.stringify({ signInTab: { cookieHost, steps } }));
    await session.close();
  }
}

await fixture.close();
writeEvidence("experiment-d", evidence);
