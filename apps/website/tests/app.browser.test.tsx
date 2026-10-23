import { render } from "preact";
import { expect, test } from "vite-plus/test";
import { App } from "@/app/App";
import type { ExtensionGateway } from "@/services/extension";
import { INSTALL_GUIDE_URL } from "@/ui/InstallBanner";
import { installedGateway, missingGateway } from "./fake-gateway.ts";

function mount(gateway: ExtensionGateway) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App gateway={gateway} />, root);
  return root;
}

test("says it is looking for the extension until detection settles", () => {
  const root = mount({ detect: () => new Promise(() => {}) });
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

test("leaves the page to the extension's dashboard when it is installed", async () => {
  const root = mount(installedGateway);
  await expect
    .poll(() => root.querySelector('[role="status"]')?.textContent)
    .toBe("Opening your RECnRun dashboard…");
  expect(root.querySelector('[data-testid="extension-version"]')?.textContent).toBe(
    "Extension 0.1.0",
  );
  expect(root.querySelector(".banner, article")).toBeNull();
});

test("links to the privacy policy", () => {
  const root = mount(missingGateway);
  const link = [...root.querySelectorAll("a")].find((a) => a.textContent === "Privacy policy");
  expect(link?.getAttribute("href")).toBe("/privacy/");
});
