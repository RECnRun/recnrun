// Phase E, the four-identity workflow and the overhead: four containers and the control sign in
// to one app, each container does its own step on 20 requests in parallel, and every step must be
// made by its user only. Then each variant's request and page-load times are measured.
// Run: node scripts/containers-lab/workflow.mjs [variant...]
import { APP, startFixture } from "./fixture-server.mjs";
import { launchLab, openTab, signIn, writeEvidence } from "./lab-browser.mjs";

const USERS = ["Admin", "Requester", "Approver", "Supervisor"];
const STEPS = { Admin: "create", Requester: "submit", Approver: "approve", Supervisor: "complete" };
const SAMPLES = 100;

const post = (page, step, ids) =>
  page.evaluate(
    ([name, list]) =>
      Promise.all(
        list.map((id) =>
          fetch("/workflow", { method: "POST", body: JSON.stringify({ step: name, id }) }).then(
            (response) => response.json(),
          ),
        ),
      ),
    [step, ids],
  );

/** `prefix` keeps each variant's requests apart in the one fixture server. */
async function workflow(tabs, prefix) {
  const IDS = Array.from({ length: 20 }, (_, index) => `${prefix}-${index}`);
  const result = { outOfTurn: {} };
  // Before its turn and from the wrong identity, every step must be refused.
  result.outOfTurn.controlCreates = await post(tabs.Control.page, "create", [`${prefix}-control`]);
  result.outOfTurn.requesterApproves = await post(tabs.Requester.page, "approve", [IDS[0]]);
  for (const user of USERS)
    result[STEPS[user]] = (await post(tabs[user].page, STEPS[user], IDS)).filter(
      ({ ok }) => ok,
    ).length;
  const histories = await tabs.Control.page.evaluate(
    (list) =>
      Promise.all(
        list.map((id) => fetch(`/workflow?id=${id}`).then((response) => response.json())),
      ),
    IDS,
  );
  result.wrongHistories = histories.filter(
    (entry) =>
      entry?.state !== "completed" || entry.history.some(({ step, user }) => STEPS[user] !== step),
  ).length;
  return result;
}

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

async function overhead(page) {
  const fetches = await page.evaluate(async (count) => {
    const times = [];
    for (let index = 0; index < count; index += 1) {
      const start = performance.now();
      await (await fetch(`/me?sample=${index}`)).json();
      times.push(performance.now() - start);
    }
    return times;
  }, SAMPLES);
  const loads = [];
  for (let index = 0; index < 20; index += 1) {
    await page.goto(`${APP}/home?sample=${index}`);
    loads.push(await page.evaluate(() => performance.getEntriesByType("navigation")[0].duration));
  }
  return {
    fetchMedianMs: median(fetches),
    fetchMaxMs: Math.max(...fetches),
    loadMedianMs: median(loads),
  };
}

async function runVariant(variant) {
  const lab = await launchLab();
  try {
    await lab.lab.setVariant(variant);
    const tabs = {};
    for (const user of [...USERS, "Control"])
      tabs[user] = await openTab(lab, user === "Control" ? undefined : user);
    const signedIn = {};
    for (const [user, tab] of Object.entries(tabs)) signedIn[user] = await signIn(tab.page, user);
    return {
      variant,
      chromium: lab.version,
      signedIn,
      workflow: await workflow(tabs, variant),
      overhead: await overhead(tabs.Admin.page),
    };
  } finally {
    await lab.close();
  }
}

const fixture = await startFixture();
try {
  const variants = process.argv.slice(2);
  for (const variant of variants.length > 0 ? variants : ["off", "N1", "N2", "N2B1"]) {
    console.log("evidence:", writeEvidence(`workflow-${variant}`, await runVariant(variant)));
  }
} finally {
  await fixture.close();
}
