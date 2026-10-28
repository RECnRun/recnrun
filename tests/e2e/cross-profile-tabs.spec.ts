import type { Page } from "@playwright/test";
import { expect } from "./fixtures/extension.ts";
import { dashboardIn as openIn, pair, test } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";
import { activeTabId, clickToOpenPanel, panelIn } from "./fixtures/session.ts";
import { storedSession, tabIdOf } from "./fixtures/tabs.ts";

const LOCAL = "Chrome — Profile A (Local)";
const REMOTE = "Chrome — Profile B (Connected)";

/** A dashboard tab in a profile, A by default, that lists both profiles. */
async function dashboardIn(profile: Profile, local = LOCAL): Promise<{ dashboard: Page }> {
  const dashboard = await openIn(profile);
  await expect(dashboard.getByRole("heading", { name: local })).toBeVisible();
  return { dashboard };
}

/** A tab in a profile, at an address of its own; the privacy policy runs no RECnRun script. */
async function openTab(profile: Profile, name: string): Promise<Page> {
  const page = await profile.context.newPage();
  await page.goto(`/privacy/?${name}`);
  return page;
}

const remoteTab = (dashboard: Page, url: string, heading = REMOTE) =>
  dashboard
    .getByRole("complementary", { name: heading })
    .getByRole("listitem")
    .filter({ hasText: url });

test("the dashboard lists the other profile's tabs as they open and close", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const b = await openTab(profileB, "opened");
  await expect(remoteTab(dashboard, b.url())).toBeVisible();
  // A's own list never shows B's tab.
  await expect(
    dashboard.getByRole("complementary", { name: LOCAL }).getByText(b.url()),
  ).toHaveCount(0);
  await b.close();
  await expect(remoteTab(dashboard, b.url())).toHaveCount(0);
});

test("Show tab brings the other profile's tab to the front there", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const first = await openTab(profileB, "first");
  await openTab(profileB, "second");
  const firstId = await tabIdOf(profileB.serviceWorker, first.url());
  expect(await activeTabId(profileB.serviceWorker)).not.toBe(firstId);
  await remoteTab(dashboard, first.url()).getByRole("button", { name: "Show tab" }).click();
  await expect.poll(() => activeTabId(profileB.serviceWorker)).toBe(firstId);
});

test("A records, pauses, and stops a session that runs in B, from its PiP window", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const app = await openTab(profileB, "app");
  const appId = await tabIdOf(profileB.serviceWorker, app.url());
  const record = remoteTab(dashboard, app.url()).getByRole("button", { name: "Record" });
  const pip = await clickToOpenPanel(profileA.context, record);

  await expect(panelIn(pip)).toContainText("Recording");
  await expect
    .poll(() => storedSession(profileB.serviceWorker))
    .toMatchObject({ tabId: appId, status: "recording" });
  // The session is B's alone: A runs none of its own.
  expect(await storedSession(profileA.serviceWorker)).toBeNull();

  await panelIn(pip).getByRole("button", { name: "Pause" }).click();
  await expect
    .poll(() => storedSession(profileB.serviceWorker))
    .toMatchObject({ status: "paused" });
  await expect(panelIn(pip)).toContainText("Paused");

  const closed = pip.waitForEvent("close");
  await panelIn(pip).getByRole("button", { name: "Stop" }).click();
  await closed;
  await expect.poll(() => storedSession(profileB.serviceWorker)).toBeNull();
});

interface WorkerVersions {
  versions: { scriptURL: string; runningStatus: string }[];
}

/**
 * Stops the profile's service worker, as Chrome does when it idles, and waits until it stopped.
 * Playwright reports no close for an extension's worker, so the DevTools protocol says when.
 */
async function stopServiceWorker(profile: Profile): Promise<void> {
  const cdp = await profile.context.newCDPSession(profile.pairing);
  const stopped = new Promise<void>((resolve) =>
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }: WorkerVersions) => {
      if (versions.some((each) => each.runningStatus === "stopped")) resolve();
    }),
  );
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await stopped;
  await cdp.detach();
}

test("a session in B outlives the link, and A shows B's tabs read only, as last seen", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const app = await openTab(profileB, "app");
  const record = remoteTab(dashboard, app.url()).getByRole("button", { name: "Record" });
  const pip = await clickToOpenPanel(profileA.context, record);
  await expect(panelIn(pip)).toContainText("Recording");

  // The PiP window floats only a session the link still reports, so it closes with the link.
  const closed = pip.waitForEvent("close");
  await profileA.pairing.getByRole("button", { name: "Disconnect" }).click();
  await closed;
  const down = "Chrome — Profile B (Disconnected)";
  const remote = dashboard.getByRole("complementary", { name: down });
  const readOnly = async () => {
    await expect(remote).toContainText("Not connected. Last seen recording.");
    await expect(remoteTab(dashboard, app.url(), down)).toBeVisible();
    await expect(remote.getByRole("button")).toHaveCount(0);
    await expect(remote.getByText("Closed tab")).toHaveCount(0);
  };
  await readOnly();

  // A worker that sleeps and wakes again still has the tabs last seen.
  await stopServiceWorker(profileA);
  await dashboard.reload();
  await readOnly();
  // Only an explicit Stop ends a session; B's keeps recording.
  expect(await storedSession(profileB.serviceWorker)).toMatchObject({ status: "recording" });
});

test("while B records a session of its own, neither dashboard offers Record", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const inA = (await dashboardIn(profileA)).dashboard;
  const inB = (await dashboardIn(profileB, "Chrome — Profile B (Local)")).dashboard;
  const app = await openTab(profileB, "app");
  const records = (dashboard: Page) => dashboard.getByRole("button", { name: "Record" });
  await expect(remoteTab(inA, app.url()).getByRole("button", { name: "Record" })).toBeVisible();

  const local = remoteTab(inB, app.url(), "Chrome — Profile B (Local)");
  await clickToOpenPanel(profileB.context, local.getByRole("button", { name: "Record" }));
  await expect
    .poll(() => storedSession(profileB.serviceWorker))
    .toMatchObject({ status: "recording" });
  await expect(records(inA)).toHaveCount(0);
  await expect(inA.getByText("Recording in Profile B")).toHaveCount(2);
  await expect(records(inB)).toHaveCount(0);
});

test("neither profile lists RECnRun's own pages, such as its pairing tab", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const app = await openTab(profileB, "app");
  const local = await openTab(profileA, "local");
  await expect(remoteTab(dashboard, app.url())).toBeVisible();
  await expect(remoteTab(dashboard, local.url(), LOCAL)).toBeVisible();
  await expect(dashboard.getByText("RECnRun pairing")).toHaveCount(0);
  await expect(dashboard.getByText(dashboard.url())).toHaveCount(0);
});
