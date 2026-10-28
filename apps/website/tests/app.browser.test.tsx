import { render } from "preact";
import { expect, test } from "vite-plus/test";
import { App } from "@/app/App";
import type { ExtensionGateway } from "@/services/extension";
import { INSTALL_GUIDE_URL } from "@/ui/InstallBanner";
import { dashboardGateway, missingGateway } from "./fake-gateway.ts";

function mount(gateway: ExtensionGateway) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App gateway={gateway} />, root);
  return root;
}

test("says it is looking for the extension until detection settles", () => {
  const root = mount({ detect: () => new Promise(() => {}), openDashboard: async () => {} });
  expect(root.querySelector('[role="status"]')?.textContent).toBe(
    "Looking for the RECnRun extension…",
  );
});

test("asks to install the extension when it is missing", async () => {
  const root = mount(missingGateway);
  await expect
    .poll(() => root.querySelector(".banner h2")?.textContent)
    .toBe("Install the RECnRun extension");
  expect(root.querySelector("a.button")?.getAttribute("href")).toBe(INSTALL_GUIDE_URL);
});

const openButton = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].find((each) => each.textContent === "Open dashboard");

test("brings the extension's dashboard forward once, and again on Open dashboard", async () => {
  const { gateway, opened } = dashboardGateway();
  const root = mount(gateway);
  await expect.poll(() => openButton(root)).toBeDefined();
  expect(opened).toHaveLength(1);
  expect(root.querySelector('[data-testid="extension-version"]')?.textContent).toBe(
    "Extension 0.1.0",
  );
  expect(root.querySelector("article")).toBeNull();

  openButton(root)?.click();
  await expect.poll(() => opened.length).toBe(2);
  expect(root.querySelector('[role="alert"]')).toBeNull();
});

test("points to the toolbar icon when the extension does not open its dashboard", async () => {
  const { gateway } = dashboardGateway(new Error("Timed out waiting for the response."));
  const root = mount(gateway);
  await expect.poll(() => root.querySelector('[role="alert"]')?.textContent).toContain("toolbar");
});

test("never asks a missing extension to open anything", async () => {
  const { opened } = dashboardGateway();
  const root = mount({ ...missingGateway, openDashboard: async () => void opened.push(true) });
  await expect.poll(() => root.querySelector(".banner h2")?.textContent).toBeDefined();
  expect(opened).toEqual([]);
  expect(openButton(root)).toBeUndefined();
});

test("links to the privacy policy", () => {
  const root = mount(missingGateway);
  const link = [...root.querySelectorAll("a")].find((a) => a.textContent === "Privacy policy");
  expect(link?.getAttribute("href")).toBe("/privacy/");
});
