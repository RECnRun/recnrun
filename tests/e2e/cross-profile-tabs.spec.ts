import type { FrameLocator, Page } from "@playwright/test";
import { expect } from "./fixtures/extension.ts";
import { pair, test } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";
import {
  activeTabId,
  clickInDashboard,
  clickToOpenPanel,
  dashboardOf,
  panelIn,
} from "./fixtures/session.ts";
import { storedSession, tabIdOf } from "./fixtures/tabs.ts";

const LOCAL = "Chrome — Profile A (Local)";
const REMOTE = "Chrome — Profile B (Connected)";

/** A's site tab, whose dashboard lists both profiles. */
async function dashboardIn(profile: Profile): Promise<{ site: Page; dashboard: FrameLocator }> {
  const site = await profile.context.newPage();
  await site.goto("/");
  const dashboard = dashboardOf(site);
  await expect(dashboard.getByRole("heading", { name: LOCAL })).toBeVisible();
  return { site, dashboard };
}

/** A tab in profile B, at an address of its own; the privacy policy has no dashboard frame. */
async function openInB(profile: Profile, name: string): Promise<Page> {
  const page = await profile.context.newPage();
  await page.goto(`/privacy/?${name}`);
  return page;
}

const remoteTab = (dashboard: FrameLocator, url: string, heading = REMOTE) =>
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
  const b = await openInB(profileB, "opened");
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
  const first = await openInB(profileB, "first");
  await openInB(profileB, "second");
  const firstId = await tabIdOf(profileB.serviceWorker, first.url());
  expect(await activeTabId(profileB.serviceWorker)).not.toBe(firstId);
  await clickInDashboard(
    remoteTab(dashboard, first.url()).getByRole("button", { name: "Show tab" }),
  );
  await expect.poll(() => activeTabId(profileB.serviceWorker)).toBe(firstId);
});

test("A records, pauses, and stops a session that runs in B, from its PiP window", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const app = await openInB(profileB, "app");
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

test("a session in B outlives the link, and A shows the other profile disconnected", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const { dashboard } = await dashboardIn(profileA);
  const app = await openInB(profileB, "app");
  const record = remoteTab(dashboard, app.url()).getByRole("button", { name: "Record" });
  const pip = await clickToOpenPanel(profileA.context, record);
  await expect(panelIn(pip)).toContainText("Recording");

  await profileA.pairing.getByRole("button", { name: "Disconnect" }).click();
  await expect(
    dashboard.getByRole("heading", { name: /^Chrome — Profile B \((Disconnected|Error)\)$/ }),
  ).toBeVisible();
  // Only an explicit Stop ends a session; B's keeps recording.
  expect(await storedSession(profileB.serviceWorker)).toMatchObject({ status: "recording" });
  await panelIn(pip).getByRole("button", { name: "Stop" }).click();
  await expect(panelIn(pip).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(await storedSession(profileB.serviceWorker)).toMatchObject({ status: "recording" });
});
