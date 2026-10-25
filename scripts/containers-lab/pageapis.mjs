// Phase C, the page API marker matrix: four containers (Admin with a second tab) and the control
// write their own marker into every API and read them all back, then a broadcast and a storage
// event from Admin must reach Admin's second tab only.
// Run: node scripts/containers-lab/pageapis.mjs [variant...]
import { APP, startFixture } from "./fixture-server.mjs";
import { launchLab, openTab, writeEvidence } from "./lab-browser.mjs";

const WRITERS = ["Admin", "Requester", "Approver", "Supervisor", "Control"];
const FIELDS = ["localStorage", "sessionStorage", "cookie", "indexedDB", "cache", "opfs"];

async function openAll(lab) {
  const tabs = {};
  for (const name of WRITERS)
    tabs[name] = await openTab(lab, name === "Control" ? undefined : name, "/apis");
  tabs.Admin2 = await openTab(lab, "Admin", "/apis");
  for (const tab of Object.values(tabs))
    await tab.page.waitForFunction(() => window.apis !== undefined);
  return tabs;
}

/** Fields where a tab does not read its own container's marker; Admin2 belongs to Admin. */
function leaksOf(name, read) {
  const expected = name === "Admin2" ? "Admin" : name;
  const wrong = FIELDS.filter(
    (field) => read[field] !== expected && !(field === "sessionStorage" && name === "Admin2"),
  );
  return wrong.map((field) => `${field}=${read[field]}`);
}

async function cookieOnNetwork(fixture, tabs) {
  await fetch(`${APP}/__reset`, { method: "POST" });
  const sent = {};
  for (const [name, tab] of Object.entries(tabs)) {
    await tab.page.evaluate((tag) => fetch(`/poll?tag=${tag}`), name);
    const entry = fixture.state.log.find((logged) => logged.tag === name);
    sent[name] = /(?:^|; )marker=([^;]*)/.exec(entry?.cookie ?? "")?.[1] ?? null;
  }
  return sent;
}

async function channels(tabs) {
  for (const tab of Object.values(tabs)) await tab.page.evaluate(() => window.apis.listen());
  await tabs.Admin.page.evaluate(() => window.apis.broadcast("logout-Admin"));
  await tabs.Admin.page.waitForTimeout(500);
  const heard = {};
  for (const [name, tab] of Object.entries(tabs))
    heard[name] = await tab.page.evaluate(() => window.apis.heard());
  const reached = Object.keys(heard).filter(
    (name) => heard[name].received.length + heard[name].storageEvents.length > 0,
  );
  return { reached, heard };
}

async function matrix(tabs) {
  const reads = {};
  for (const [name, tab] of Object.entries(tabs))
    reads[name] = await tab.page.evaluate(() => window.apis.read());
  const leaks = Object.fromEntries(
    Object.entries(reads).map(([name, read]) => [name, leaksOf(name, read)]),
  );
  const { localKeys, databases, cacheKeys, heldLocks } = reads.Control;
  leaks.Control.push(
    ...[...localKeys, ...databases, ...cacheKeys, ...heldLocks].filter((name) =>
      name.startsWith("rnr"),
    ),
  );
  return { reads, leaks };
}

/** What ran first in each tab, then every writer's marker in every API. */
async function writeAll(tabs) {
  const result = { firstScript: {} };
  for (const [name, tab] of Object.entries(tabs))
    result.firstScript[name] = await tab.page.evaluate(() => window.firstScript);
  for (const name of WRITERS)
    result[`wrote${name}`] = await tabs[name].page.evaluate(
      (marker) => window.apis.write(marker),
      name,
    );
  return result;
}

async function runVariant(variant, fixture) {
  const lab = await launchLab();
  try {
    await lab.lab.setVariant(variant);
    const tabs = await openAll(lab);
    const result = { variant, chromium: lab.version, ...(await writeAll(tabs)) };
    result.matrix = await matrix(tabs);
    result.network = await cookieOnNetwork(fixture, tabs);
    for (const tab of Object.values(tabs)) await tab.page.reload();
    for (const tab of Object.values(tabs))
      await tab.page.waitForFunction(() => window.apis !== undefined);
    result.afterReload = (await matrix(tabs)).leaks;
    result.channels = await channels(tabs);
    result.bypass = { freshRealm: await tabs.Admin.page.evaluate(() => window.apis.freshRealm()) };
    result.events = (await lab.lab.events()).filter(({ type }) => /failed/.test(type)).slice(0, 5);
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
      writeEvidence(`pageapis-${variant}`, await runVariant(variant, fixture)),
    );
  }
} finally {
  await fixture.close();
}
