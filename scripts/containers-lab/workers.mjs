// Phase D, workers and shared caches: each container's dedicated, module, and shared workers write
// and read a marker and ask /me who they are; the control's service worker must not control a
// container tab; a private response cached for one identity must not reach another.
// Run: node scripts/containers-lab/workers.mjs [variant...]
import { APP, startFixture } from "./fixture-server.mjs";
import { launchLab, openTab, signIn, writeEvidence } from "./lab-browser.mjs";

const WRITERS = ["Admin", "Requester", "Approver", "Supervisor", "Control"];
const KINDS = ["dedicated", "module", "shared"];

async function openSignedIn(lab) {
  const tabs = {};
  for (const name of [...WRITERS, "Admin2"]) {
    const title = name === "Control" ? undefined : name.replace("2", "");
    tabs[name] = await openTab(lab, title);
    if (name !== "Admin2") await signIn(tabs[name].page, name);
    await tabs[name].page.goto(`${APP}/apis`);
    await tabs[name].page.waitForFunction(() => window.apis !== undefined);
  }
  return tabs;
}

const expected = (name) => (name === "Admin2" ? "Admin" : name);

async function workerRuns(tabs, kind) {
  for (const name of WRITERS)
    await tabs[name].page.evaluate(([k, write]) => window.apis.worker(k, { write }), [kind, name]);
  const reads = {};
  for (const [name, tab] of Object.entries(tabs))
    reads[name] = await tab.page.evaluate((k) => window.apis.worker(k, {}), kind);
  const wrong = Object.entries(reads).filter(
    ([name, read]) => read.me !== expected(name) || read.marker !== expected(name),
  );
  const instances = Object.fromEntries(
    Object.entries(reads).map(([name, read]) => [name, read.instance]),
  );
  return {
    wrong: wrong.map(
      ([name, read]) => `${name}: me=${read.me} marker=${read.marker}${read.error ?? ""}`,
    ),
    instances,
  };
}

async function serviceWorker(tabs) {
  const control = tabs.Control.page;
  await control.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  const seen = {};
  for (const [name, tab] of Object.entries(tabs)) {
    await tab.page.goto(`${APP}/sw-check`);
    seen[name] = await tab.page.textContent("#user");
  }
  seen.registerInContainer = await tabs.Admin.page.evaluate(() =>
    navigator.serviceWorker.register("/sw.js").then(
      () => "registered",
      (error) => error.name,
    ),
  );
  return seen;
}

async function httpCache(tabs) {
  const seen = {};
  for (const name of ["Admin", "Requester", "Control"]) {
    await tabs[name].page.goto(`${APP}/me-cached`);
    seen[name] = JSON.parse(await tabs[name].page.textContent("body")).user;
  }
  return seen;
}

async function runVariant(variant, fixture) {
  const lab = await launchLab();
  try {
    await lab.lab.setVariant(variant);
    const tabs = await openSignedIn(lab);
    const result = { variant, chromium: lab.version, workers: {} };
    for (const kind of KINDS) result.workers[kind] = await workerRuns(tabs, kind);
    result.targets = (await lab.lab.targets())
      .filter(({ type }) => type !== "page")
      .map(({ type, url, title, attached }) => ({ type, url, title, attached }));
    result.cache = await httpCache(tabs);
    result.cacheRequests = fixture.state.log.filter(({ path }) => path === "/me-cached").length;
    result.serviceWorker = await serviceWorker(tabs);
    result.events = (await lab.lab.events())
      .filter(({ type }) => /failed|missing|b1-worker|shared/.test(type))
      .slice(0, 30);
    return result;
  } finally {
    await lab.close();
  }
}

const fixture = await startFixture();
try {
  const variants = process.argv.slice(2);
  for (const variant of variants.length > 0 ? variants : ["off", "N2", "N2B1"]) {
    console.log(
      "evidence:",
      writeEvidence(`workers-${variant}`, await runVariant(variant, fixture)),
    );
  }
} finally {
  await fixture.close();
}
