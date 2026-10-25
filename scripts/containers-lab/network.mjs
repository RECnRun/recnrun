// Phase B, the network cookie kill test: for each variant, two containers and a control tab sign in
// to the same app, and the fixture's request log says which identity every request carried.
// Run: node scripts/containers-lab/network.mjs [variant...]
import { APP, IDP, startFixture } from "./fixture-server.mjs";
import {
  launchLab,
  openTab,
  readAfterReloads,
  signIn,
  whoAmI,
  writeEvidence,
} from "./lab-browser.mjs";

const RUNS = 50;
const POLLS = 500;

const userOfCookie = (fixture, cookie) => {
  const sids = cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith("sid="));
  return sids.map((pair) => fixture.state.sessions.get(pair.slice(4)) ?? "unknown");
};

/** The page shows `user` within 1.5 seconds, as after N1r reloads a stale navigation. */
const settlesOn = (page, user) =>
  page
    .waitForFunction(
      (expected) => document.querySelector("#user")?.textContent === expected,
      user,
      { timeout: 1500 },
    )
    .then(
      () => true,
      () => false,
    );

async function redirectRuns(tab, user) {
  const result = { runs: RUNS, signedOut: 0, firstRender: 0, eventually: 0 };
  for (let run = 0; run < RUNS; run += 1) {
    await tab.page.goto(`${APP}/logout`);
    if (await settlesOn(tab.page, "signed out")) result.signedOut += 1;
    if ((await signIn(tab.page, user)) === user) result.firstRender += 1;
    if (await settlesOn(tab.page, user)) result.eventually += 1;
  }
  return result;
}

const poll = (page, tag) =>
  page.evaluate(
    async ([prefix, count]) => {
      const one = (index) =>
        fetch(`/poll?tag=${prefix}-${index}`).then((response) => response.json());
      return Promise.all(Array.from({ length: count }, (_, index) => one(index)));
    },
    [tag, POLLS],
  );

/** Both containers and the control poll at once while Requester signs in again and again. */
async function concurrency(fixture, tabs) {
  await fetch(`${APP}/__reset`, { method: "POST" });
  const relogins = (async () => {
    for (let run = 0; run < 10; run += 1) await signIn(tabs.relogin.page, "Requester");
  })();
  await Promise.all([poll(tabs.admin.page, "Admin"), poll(tabs.control.page, "Control"), relogins]);
  const polled = fixture.state.log.filter((entry) => entry.path === "/poll");
  const wrong = polled.filter((entry) => {
    const users = userOfCookie(fixture, entry.cookie);
    return users.length !== 1 || users[0] !== entry.tag.split("-")[0];
  });
  return { requests: polled.length, wrong: wrong.length, samples: wrong.slice(0, 5) };
}

const socketUser = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws`);
        socket.onmessage = ({ data }) => resolve(JSON.parse(data).user);
        socket.onerror = () => resolve("error");
      }),
  );

async function frames(page) {
  await page.goto(`${APP}/frames`);
  const read = async (selector) => {
    const frame = page.frameLocator(selector).locator("#user");
    await frame.filter({ hasNotText: "…" }).waitFor();
    return frame.textContent();
  };
  return { sameOrigin: await read("#same"), crossSite: await read("#cross") };
}

/** Cross-site sign-in: app → identity provider (sets its cookie) → app callback → /home. */
async function identityProvider(page, user) {
  await page.goto(`${APP}/login-form?user=${user}`);
  await page.click("#idp");
  const home = await readAfterReloads(page, "**/home");
  await page.goto(`${IDP}/whoami`);
  const idp = JSON.parse(await page.textContent("body")).user;
  return { home, idp };
}

/**
 * The identity provider in a popup window, which is in no tab group, ten times. A leak is an
 * identity-provider cookie in Chrome's own jar: the control never visits the identity provider.
 */
async function popups(lab, page, user) {
  const result = { runs: 10, signedIn: 0, leaks: 0 };
  for (let run = 0; run < result.runs; run += 1) {
    await page.goto(`${APP}/logout`);
    await settlesOn(page, "signed out");
    await page.goto(`${APP}/login-form?user=${user}`);
    const closed = lab.context.waitForEvent("page").then((opened) => opened.waitForEvent("close"));
    await page.click("#popup");
    await closed;
    if ((await whoAmI(page)) === user) result.signedIn += 1;
    const real = await lab.lab.realCookies();
    if (real.some(({ domain }) => domain === "idp.localhost")) result.leaks += 1;
    await lab.lab.removeRealCookies("idp.localhost");
  }
  return result;
}

/** The login redirect, concurrent requests, and WebSockets, for two containers and the control. */
async function cookieRuns(lab, fixture) {
  const control = await openTab(lab, undefined);
  const controlSignIn = await signIn(control.page, "Control");
  const admin = await openTab(lab, "Admin");
  const requester = await openTab(lab, "Requester");
  const redirect = {
    admin: await redirectRuns(admin, "Admin"),
    requester: await redirectRuns(requester, "Requester"),
  };
  const requests = await concurrency(fixture, { admin, control, relogin: requester });
  const webSocket = {
    admin: await socketUser(admin.page),
    control: await socketUser(control.page),
  };
  const result = { controlSignIn, redirect, concurrency: requests, webSocket };
  return { tabs: { admin, requester, control }, result };
}

/** The identity provider, frames, and a popup, in two more containers. */
async function flowRuns(lab, admin) {
  const approver = await openTab(lab, "Approver");
  const identity = await identityProvider(approver.page, "Approver");
  const framed = { approver: await frames(approver.page), admin: await frames(admin.page) };
  const supervisor = await openTab(lab, "Supervisor");
  const popup = await popups(lab, supervisor.page, "Supervisor");
  return {
    tabs: { approver, supervisor },
    result: { identityProvider: identity, frames: framed, popup },
  };
}

async function runVariant(variant, fixture) {
  const lab = await launchLab();
  try {
    await lab.lab.setVariant(variant);
    const cookies = await cookieRuns(lab, fixture);
    const flows = await flowRuns(lab, cookies.tabs.admin);
    const after = await snapshot(lab, { ...cookies.tabs, ...flows.tabs });
    const events = summarize(await lab.lab.events());
    return { variant, chromium: lab.version, ...cookies.result, ...flows.result, after, events };
  } finally {
    await lab.close();
  }
}

async function snapshot(lab, tabs) {
  const users = {};
  for (const [name, tab] of Object.entries(tabs)) {
    await tab.page.goto(`${APP}/me`);
    users[name] = JSON.parse(await tab.page.textContent("body")).user;
  }
  const real = (await lab.lab.realCookies()).map(({ domain, name }) => `${domain} ${name}`);
  return { users, realJar: real };
}

function summarize(events) {
  const counts = {};
  for (const { type } of events) counts[type] = (counts[type] ?? 0) + 1;
  const notable = events.filter(({ type }) => /failed|detached|unassigned/.test(type)).slice(0, 10);
  return { counts, notable };
}

const fixture = await startFixture();
try {
  const variants = process.argv.slice(2);
  for (const variant of variants.length > 0 ? variants : ["off", "N1", "N1r", "N2"]) {
    console.log(
      "evidence:",
      writeEvidence(`network-${variant}`, await runVariant(variant, fixture)),
    );
  }
} finally {
  await fixture.close();
}
