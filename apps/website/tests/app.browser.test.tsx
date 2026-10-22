import { emptySnapshot } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
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

test("asks to install the extension when it is missing", async () => {
  const root = mount(missingGateway);
  await expect
    .poll(() => root.querySelector(".banner h2")?.textContent)
    .toBe("Install the RECnRun extension");
  expect(root.querySelector("a.button")?.getAttribute("href")).toBe(INSTALL_GUIDE_URL);
});

test("shows every recording, newest first", async () => {
  const root = mount(installedGateway(sampleSnapshot()));
  await expect.poll(() => root.querySelectorAll("article.recording").length).toBe(2);
  const names = [...root.querySelectorAll("article.recording h2")].map((name) => name.textContent);
  expect(names).toEqual(["Checkout with saved card", "Log in as admin"]);
  expect(root.querySelector("article.recording .start-url")?.textContent).toBe(
    "https://staging.shop.example/cart",
  );
  expect(root.querySelector('[data-testid="extension-version"]')?.textContent).toBe(
    "Extension 0.1.0",
  );
});

test("explains that an empty extension has no recordings yet", async () => {
  const root = mount(installedGateway(emptySnapshot()));
  await expect
    .poll(() => root.querySelector(".empty-state h2")?.textContent)
    .toBe("No recordings yet");
});

test("reports why the data could not be read", async () => {
  const root = mount(installedGateway(new Error("Quota exceeded")));
  await expect.poll(() => root.querySelector(".empty-state p")?.textContent).toBe("Quota exceeded");
});
