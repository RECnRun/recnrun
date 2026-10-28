import { writeFileSync } from "node:fs";
import type { Page, Worker } from "@playwright/test";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "./fixtures/extension.ts";
import { dashboardOf, openSite } from "./fixtures/session.ts";
import {
  holding,
  inspect,
  inspected,
  LOG,
  NOTHING,
  sentinelsWritten,
  writeSentinels,
} from "./fixtures/sentinels.ts";
import { openIncognitoTab } from "./fixtures/tabs.ts";
import {
  installTeardownProbe,
  readTeardown,
  spread,
  teardownGaps,
} from "./fixtures/teardown-probe.ts";
import {
  APP,
  managedWindow,
  openWorkspaceApp,
  pageAt,
  runWorkspace,
  workspacePanel,
} from "./fixtures/workspace.ts";

interface WindowsGlobal {
  chrome: { windows: { remove(windowId: number): Promise<void> } };
}

/** Closes one window as the user would, through Chrome rather than through RECnRun. */
function closeWindow(serviceWorker: Worker, windowId: number): Promise<void> {
  return serviceWorker.evaluate(
    (id) => (globalThis as unknown as WindowsGlobal).chrome.windows.remove(id),
    windowId,
  );
}

async function managedGeneration(serviceWorker: Worker): Promise<number> {
  const managed = await managedWindow(serviceWorker);
  if (managed?.status !== "active") throw new Error("No managed window is open.");
  return managed.generation;
}

/** Keeps an observation as JSON in the test's results, for the POC report to quote. */
async function keep(name: string, value: unknown): Promise<void> {
  const path = test.info().outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: "application/json" });
}

test.use({ incognitoAccess: true });

/** Reset cycles in one test; the recorded stress run sets `POC_REPEATS=50`. */
const CYCLES = Number(process.env.POC_REPEATS ?? "1");

const sentinelAt = (run: string, cycle: number) =>
  `${APP}/sentinel?tag=incog-${cycle}&run=${run}-${cycle}`;

interface Stress {
  site: Page;
  serviceWorker: Worker;
  run: string;
}

/** One cycle: the managed tab holds `incog-<cycle>`, the dashboard resets, and `/inspect` reads. */
async function resetCycle(stress: Stress, managed: Page, cycle: number) {
  const { site, serviceWorker, run } = stress;
  await sentinelsWritten(managed);
  const generation = await managedGeneration(serviceWorker);
  const target = `${APP}/inspect?run=${run}-${cycle}-inspect`;
  // Issued as soon as the writes finished, with no pause, to stress the teardown.
  await runWorkspace(site, target, "Close and start empty");
  const page = await pageAt(managed.context(), target);
  const fresh = await inspected(page);
  // The HttpOnly cookie shows in serverCookies, the Cookie header the server received.
  expect(fresh, `cycle ${cycle}`).toEqual(NOTHING);
  expect(await managedGeneration(serviceWorker)).toBe(generation + 1);
  const { entries } = (await (await fetch(`${LOG}?run=${run}-${cycle}-inspect`)).json()) as {
    entries: { kind: string; body?: { serverCookies?: object } }[];
  };
  expect(entries.find(({ kind }) => kind === "report")?.body?.serverCookies).toEqual({});
  return { page, teardown: teardownGaps(await readTeardown(serviceWorker)) };
}

test("Close and start empty leaves the next managed window with no Incognito data", async ({
  context,
  page,
  serviceWorker,
  seedSnapshot,
}) => {
  test.setTimeout(30_000 + CYCLES * 10_000);
  const run = `reset-${Date.now()}`;
  await seedSnapshot(sampleSnapshot());
  await writeSentinels(page, APP, `tag=normal&run=${run}`);
  const site = await openSite(context, "/");
  let managed = (await openWorkspaceApp(site, serviceWorker, sentinelAt(run, 1))).page;
  await installTeardownProbe(serviceWorker);
  const stress = { site, serviceWorker, run };
  const cycles: ReturnType<typeof teardownGaps>[] = [];
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    const { page: next, teardown } = await resetCycle(stress, managed, cycle);
    cycles.push(teardown);
    managed = next;
    if (cycle < CYCLES) await managed.goto(sentinelAt(run, cycle + 1));
  }
  const gaps = [
    "closeToRemoved",
    "closeToWindowLastSeen",
    "closeToNoWindow",
    "closeToStoreLastSeen",
    "closeToStoreGone",
    "removedToCreate",
    "storeGoneToCreate",
    "createToCreated",
  ] as const;
  const stats = Object.fromEntries(
    gaps.map((gap) => [gap, spread(cycles.map((each) => each[gap]))]),
  );
  const orders = [...new Set(cycles.map((each) => each.order))];
  await keep("teardown", { cycles: cycles.length, stats, orders, perCycle: cycles });

  expect(await inspect(page, APP, `${run}-normal`)).toMatchObject(holding("normal", APP));
  for (const { name } of sampleSnapshot().recordings) {
    await expect(dashboardOf(site).getByRole("article", { name })).toBeVisible();
  }
});

test("another Incognito window keeps the workspace's data, so the dashboard offers no reset", async ({
  context,
  serviceWorker,
}) => {
  const run = `control-${Date.now()}`;
  const site = await openSite(context, "/");
  const app = await openWorkspaceApp(site, serviceWorker, `${APP}/sentinel?tag=incog-1&run=${run}`);
  await sentinelsWritten(app.page);
  await openIncognitoTab(serviceWorker, "about:blank");
  const panel = workspacePanel(site);
  await expect(panel).toContainText("1 Incognito window is open");
  await expect(panel).toContainText("Close the other Incognito windows yourself");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await site.screenshot({ path: test.info().outputPath("blocked.png") });

  // What the dashboard refuses to do: close only the managed window while the other one lives.
  const managed = await managedWindow(serviceWorker);
  await closeWindow(serviceWorker, managed?.windowId ?? -1);
  const target = `${APP}/inspect?run=${run}`;
  await openIncognitoTab(serviceWorker, target);
  const survived = await inspected(await pageAt(context, target));
  await keep("control-inspected", survived);
  // Chrome keeps the Incognito session's data while any Incognito window lives; sessionStorage is per tab.
  expect(survived).toMatchObject({
    ...holding("incog-1", APP),
    sessionStorage: {},
    controller: `${APP}/sw.js`,
  });
  await expect(panel).toContainText("2 Incognito windows are open");
  await expect(panel.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
});
