// The single-tab harness: one managed tab, identities activated through the lab extension's
// session manager, and the fixture's request log as ground truth.
import { randomUUID } from "node:crypto";
import { APP, IDP, startFixture } from "../fixture-server.mjs";
import { launchLab, readAfterReloads, writeEvidence } from "../lab-browser.mjs";

export { APP, IDP, writeEvidence };

export const USERS = { A: "Admin", B: "Requester", C: "Approver" };

/** Chromium with the lab in N2B1, the fixture, and one blank managed tab. */
export async function launchSingleTab() {
  const fixture = await startFixture();
  const handle = await launchLab();
  await handle.lab.setVariant("N2B1");
  const token = randomUUID();
  const opened = handle.context.waitForEvent("page", (page) => page.url().includes(token));
  const tabId = await handle.lab.openTab(undefined, token);
  const page = await opened;
  const close = async () => {
    await handle.close().catch(() => {});
    await fixture.close();
  };
  return { ...handle, fixture, page, tabId, close };
}

/** Activates `identity` in the tab and waits for the app document; returns the switch receipt. */
export async function activate(handle, identity, options = {}) {
  const receipt = await handle.lab.activate(handle.tabId, identity, options);
  await handle.page.waitForLoadState("domcontentloaded");
  return receipt;
}

export const orderUrl = (id) => `${APP}/order?id=${id}`;
export const apisUrl = `${APP}/apis`;

/** Signs the active identity in through the form (or the identity provider) and lands on /home. */
export async function signIn(handle, user, { idp = false } = {}) {
  await handle.page.goto(`${APP}/login-form?user=${encodeURIComponent(user)}`);
  await handle.page.click(idp ? "#idp" : "button");
  return readAfterReloads(handle.page, "**/home");
}

/** The order page's state once it has asked the backend. */
export async function readOrder(page) {
  await page.waitForFunction(() => window.orderLoaded === true);
  return {
    user: await page.textContent("#user"),
    state: await page.textContent("#state"),
    history: await page.$$eval("#history li", (items) => items.map((item) => item.textContent)),
  };
}

/** Clicks a step button on the order page and waits for the page's answer. */
export async function doStep(page, step) {
  await page.click(`#${step}`);
  await page.waitForFunction(
    (name) => document.querySelector("#result").textContent.startsWith(name),
    step,
  );
  return page.textContent("#result");
}

/** The identity the app sees for this page, by a fresh request. */
export const whoAmI = (page) => page.evaluate(async () => (await (await fetch("/me")).json()).user);

const waitForApis = (page) => page.waitForFunction(() => window.apis !== undefined);

/** Writes `marker` into every page API on /apis (the page must be there already). */
export async function writeMarkers(page, marker) {
  await waitForApis(page);
  await page.evaluate((value) => window.apis.write(value), marker);
}

export async function readMarkers(page) {
  await waitForApis(page);
  return page.evaluate(() => window.apis.read());
}

/** A fresh document's identity: a nonce the harness plants, gone once the document is replaced. */
export const plantNonce = (page, nonce) =>
  page.evaluate((value) => (window.__nonce = value), nonce);
export const readNonce = (page) => page.evaluate(() => window.__nonce ?? null);
export const timeOrigin = (page) => page.evaluate(() => performance.timeOrigin);

const sidOf = (cookie) => /(?:^|; )sid=([^;]*)/.exec(cookie)?.[1] ?? null;

/** Requests the fixture logged since `since`, with the user their `sid` cookie named. */
export function requestsSince(handle, since) {
  return handle.fixture.state.log
    .filter((entry) => entry.at >= since)
    .map((entry) => ({
      ...entry,
      user: handle.fixture.state.sessions.get(sidOf(entry.cookie)) ?? null,
    }));
}

/** How many sessions the fixture created for `user`: one per sign-in. */
export const loginsOf = (handle, user) =>
  [...handle.fixture.state.sessions.values()].filter((name) => name === user).length;

/** A unique order id per test, so the fixture keeps runs apart. */
export const orderId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Events of the lab extension whose type matches `pattern`. */
export async function eventsMatching(handle, pattern) {
  return (await handle.lab.events()).filter(({ type }) => pattern.test(type));
}

/** The app tabs Chrome has: the single-tab flow must never open a second one. */
export async function appTabs(handle) {
  return (await handle.lab.tabs()).filter(({ url }) => url?.startsWith(APP));
}
