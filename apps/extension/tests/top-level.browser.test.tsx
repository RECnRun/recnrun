import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { DashboardTab } from "@/dashboard/dashboard-tab";
import { startDashboard } from "@/dashboard/start";
import { DASHBOARD_LOCK, isHeld } from "@/messaging/view-locks";
import { dashboardData } from "./dashboard-data";

const ADDRESS =
  "chrome-extension://test-id/dashboard.html?workspace=http%3A%2F%2Flocalhost%3A3000#/";

/** A dashboard tab stand-in; its address is the one the background opened it at. */
function topLevelPage() {
  const replaceState = vi.fn();
  const { search, pathname, hash } = new URL(ADDRESS);
  const page = Object.assign(new EventTarget(), {
    document,
    history: { replaceState },
    location: { ancestorOrigins: [], href: ADDRESS, search, pathname, hash },
  }) as unknown as Window;
  return { page, replaceState };
}

/** The tab's browser side, which lets the test send what the background would. */
function fakeTab() {
  let show: (workspace?: string) => void = () => {};
  const tab: DashboardTab = {
    yieldToEarlier: vi.fn(async () => {}),
    onShowWorkspace: (listener) => {
      show = listener;
      return () => {};
    },
  };
  return { tab, show: (workspace?: string) => show(workspace) };
}

const workspaces = (root: HTMLElement) =>
  [...root.querySelectorAll("section.workspace > h2")].map((heading) => heading.textContent);

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("a dashboard tab yields to an earlier one and follows the page it is moved beside", async () => {
  const { page, replaceState } = topLevelPage();
  const { tab, show } = fakeTab();
  const root = document.createElement("div");
  document.body.append(root);

  startDashboard(root, { ...dashboardData(), tab }, page);
  await expect.poll(() => workspaces(root)).toEqual(["localhost:3000"]);
  expect(tab.yieldToEarlier).toHaveBeenCalledWith(new URL(ADDRESS));
  await expect.poll(() => isHeld(DASHBOARD_LOCK)).toBe(true);

  show("https://staging.shop.example");
  await expect.poll(() => workspaces(root)).toEqual(["staging.shop.example"]);
  expect(replaceState).toHaveBeenLastCalledWith(
    null,
    "",
    "/dashboard.html?workspace=https%3A%2F%2Fstaging.shop.example#/",
  );

  show(undefined);
  await expect.poll(() => workspaces(root)).toEqual(["staging.shop.example", "localhost:3000"]);
  expect(replaceState).toHaveBeenLastCalledWith(null, "", "/dashboard.html#/");

  render(null, root);
  await expect.poll(() => isHeld(DASHBOARD_LOCK)).toBe(false);
});
