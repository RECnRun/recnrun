import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { openDashboard } from "@/background/open-dashboard";

const DASHBOARD = "chrome-extension://test-id/dashboard.html";

beforeEach(() => {
  fakeBrowser.reset();
});

const dashboardTabs = () => fakeBrowser.tabs.query({ url: DASHBOARD });

test("opens the dashboard in a new tab when none is open", async () => {
  await openDashboard(DASHBOARD);
  expect(await dashboardTabs()).toHaveLength(1);
});

test("focuses an open dashboard tab instead of opening another", async () => {
  await openDashboard(DASHBOARD);
  const other = await fakeBrowser.tabs.create({ url: "https://example.com/" });
  expect((await dashboardTabs())[0]?.active).toBe(false);

  await openDashboard(DASHBOARD);
  const tabs = await dashboardTabs();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]?.active).toBe(true);
  expect((await fakeBrowser.tabs.get(other.id ?? -1)).active).toBe(false);
});
