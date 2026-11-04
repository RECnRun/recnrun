import { setTimeout as delay } from "node:timers/promises";
import { listOf } from "../e2e/fixtures/mesh.ts";
import { peerStatus } from "../e2e/fixtures/profiles.ts";
import type { Profile } from "../e2e/fixtures/profiles.ts";
import { virtualPeer } from "../experiments/fixtures/e5-virtual.ts";
import { expect, test as base } from "./fixtures/chrome.ts";
import {
  createDownloadsGroup,
  linkedPeers,
  nameProfile,
  openViews,
  tempPlatform,
  waitForMesh,
} from "./fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./fixtures/downloads-profiles.ts";
import {
  askPeers,
  boundHierarchy,
  hierarchyOf,
  isActive,
  linesWith,
  startWork,
  tabOf,
  workOf,
} from "./fixtures/master-restart.ts";
import type { Hierarchy } from "./fixtures/master-restart.ts";
import { backgroundLog, within } from "./fixtures/trust.ts";

/*
 * POC PLAN.md P3.5 on Google Chrome Stable: the Default, bound as the master of two workers over
 * Downloads, starts a session in Worker 1 and quits. Its workers keep their binding and the
 * session, Worker 1's own dashboard gets the session's controls back, and both refuse a forger
 * who claims the Default's id. The same Default comes back on its root, relinks under the pins it
 * had, shows the session again, and stops it with one command; Worker 1 never gets a second
 * start. A worker restart, by contrast, leaves the master running and its other link up.
 * Worker-to-worker control is refused in hierarchy.spec.ts.
 */

const GONE_MS = 15_000;
const REFUSED_MS = 30_000;
const RELINK_MS = 60_000;
const CONTROLLED = "Controlled from Default";

interface Lab {
  group: DownloadsGroup;
  hierarchy: Hierarchy;
  views: Map<DownloadsProfile, Profile>;
  baseURL: string;
}

const test = base.extend<{ lab: Lab }>({
  lab: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
    const group = await createDownloadsGroup(tempPlatform("recnrun-master"));
    try {
      const views = new Map<DownloadsProfile, Profile>();
      const hierarchy = await boundHierarchy(group, async (profile) => {
        const view = await openViews(profile, baseURL);
        // Named before the catalog lists anyone, so every pairing code carries the name.
        await nameProfile(view);
        views.set(profile, view);
      });
      await use({ group, hierarchy, views, baseURL });
    } finally {
      await group.dispose();
    }
  },
});

// Three launches, the mesh, and a relaunch run in one test.
test.describe.configure({ timeout: 300_000 });

function viewOf(lab: Lab, profile: DownloadsProfile): Profile {
  const view = lab.views.get(profile);
  if (!view) throw new Error(`${profile.name} has no views.`);
  return view;
}

const gone = (name: string) => new RegExp(`^(Disconnected|Not reachable) — ${name}$`);

async function attachDashboard(view: Profile, name: string) {
  const body = await view.dashboard.screenshot({ fullPage: true });
  await test.info().attach(name, { body, contentType: "image/png" });
}

/** A forger writes a presence under the master's id, with a key of its own, and an offer to each worker. */
async function forgeMaster({ group, hierarchy }: Lab) {
  const { master, workers } = hierarchy;
  const page = await workers[0].context.newPage();
  const forger = await virtualPeer(page, group.downloads, master.profileId);
  await forger.announce();
  for (const worker of workers) {
    const offer = await forger.signal("offer", worker.profileId);
    await forger.write("offer", worker.profileId, JSON.stringify(offer));
  }
  return forger;
}

/** Whether `log` shows the refusal of the forged presence (offerer) or of its offer (answerer). */
const refusedForger = (log: string[], masterId: string) =>
  [
    `no offer to ${masterId}: its certificate is signed by another identity than the one pinned`,
    `Refused a code from ${masterId}: its pinned identity did not sign its certificate.`,
  ].some((text) => linesWith(log, text).length > 0);

/** What the master left in its workers when it quit, to hold while it is closed and after. */
interface Left {
  logs: string[][];
  before: Awaited<ReturnType<typeof hierarchyOf>>[];
  work: Awaited<ReturnType<typeof workOf>>;
}

/** The Default quits: its workers see it go, keep their binding and the session, and refuse a forger. */
async function whileClosed(lab: Lab, { logs, before, work }: Left) {
  const { master, workers } = lab.hierarchy;
  const busyView = viewOf(lab, workers[0]);
  await lab.group.quit(master);
  for (const worker of workers)
    await expect(peerStatus(viewOf(lab, worker), master)).toHaveText(gone(master.name), {
      timeout: GONE_MS,
    });
  // With no verified link to the profile that started it, the session's controls go back to Worker 1.
  await expect(busyView.dashboard.getByText(CONTROLLED)).toHaveCount(0);
  await attachDashboard(busyView, "Worker 1 while the Default is closed");
  const forger = await forgeMaster(lab);
  for (const [index, worker] of workers.entries()) {
    const log = logs[index] ?? [];
    const refused = within(
      async () => (refusedForger(log, master.profileId) ? true : undefined),
      REFUSED_MS,
    );
    expect(await refused, log.join("\n")).toBe(true);
    expect(await linkedPeers(worker)).not.toContain(master.profileId);
  }
  forger.stop();
  expect(await Promise.all(workers.map(hierarchyOf))).toEqual(before.slice(1));
  expect(await workOf(workers[0])).toEqual(work);
}

/** The same Default on its root: it relinks under its pins, shows the session, and stops it. */
async function onReturn(lab: Lab, { logs, before, work }: Left) {
  const { master, workers } = lab.hierarchy;
  const [busy, idle] = workers;
  const heard = logs[0]?.length ?? 0;
  const relaunched = Date.now();
  await lab.group.relaunch(master);
  await waitForMesh([master, ...workers], RELINK_MS);
  const description = `linked with both workers ${Date.now() - relaunched} ms after the relaunch`;
  test.info().annotations.push({ type: "relink", description });
  expect(await Promise.all([master, ...workers].map(hierarchyOf))).toEqual(before);
  const back = await openViews(master, lab.baseURL);
  await expect(listOf(back, viewOf(lab, idle))).toContainText(`Recording in ${busy.name}`);
  await expect(viewOf(lab, busy).dashboard.getByText(CONTROLLED)).toBeVisible();
  await attachDashboard(back, "the Default back on its root");
  // The session's state waited in Worker 1, so the master asks for no second start.
  expect(linesWith(logs[0] ?? [], "received SESSION_START", heard)).toEqual([]);
  expect(await workOf(busy)).toEqual(work);
  const stop = { type: "session-stop", peer: busy.profileId };
  expect(await askPeers(back.dashboard, stop)).toEqual({ ok: true });
  await expect.poll(async () => (await workOf(busy)).session).toBeNull();
}

test("the Default's workers keep its binding and session while it is closed, and it takes them back", async ({
  lab,
}) => {
  const { master, workers } = lab.hierarchy;
  const [busy] = workers;
  const logs = workers.map((each) => backgroundLog(each.context));
  await startWork(viewOf(lab, master).dashboard, busy);
  await expect(viewOf(lab, busy).dashboard.getByText(CONTROLLED)).toBeVisible();
  const before = await Promise.all([master, ...workers].map(hierarchyOf));
  const work = await workOf(busy);
  expect(work).toMatchObject({ session: { status: "recording" }, controlledBy: master.profileId });
  await whileClosed(lab, { logs, before, work });
  await onReturn(lab, { logs, before, work });
});

test("a worker restart is not the master's: the Default sees Worker 2 leave and return bound, and keeps Worker 1", async ({
  lab,
}) => {
  const { group, hierarchy } = lab;
  const { master, workers } = hierarchy;
  const [steady, restarting] = workers;
  const masterView = viewOf(lab, master);
  const before = await Promise.all([master, restarting].map(hierarchyOf));
  const watching = { on: true, drops: 0 };
  const watch = (async () => {
    while (watching.on) {
      if (!(await linkedPeers(master)).includes(steady.profileId)) watching.drops += 1;
      await delay(250);
    }
  })();

  await group.quit(restarting);
  const status = peerStatus(masterView, restarting);
  await expect(status).toHaveText(gone(restarting.name), { timeout: GONE_MS });
  await group.relaunch(restarting);
  await waitForMesh([master, restarting], RELINK_MS);
  await expect(status).toHaveText(`Connected — ${restarting.name}`);
  watching.on = false;
  await watch;
  expect(watching.drops, "the master's link with Worker 1 dropped").toBe(0);
  expect(await Promise.all([master, restarting].map(hierarchyOf))).toEqual(before);
  await attachDashboard(masterView, "the Default after Worker 2 restarted");
  // Still bound: a command from the Default's dashboard runs in the restarted worker.
  const tabId = await tabOf(restarting, "after the restart");
  const activate = { type: "activate", peer: restarting.profileId, tabId };
  expect(await askPeers(masterView.dashboard, activate)).toEqual({ ok: true });
  await expect.poll(() => isActive(restarting, tabId)).toBe(true);
});
