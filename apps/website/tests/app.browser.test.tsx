import { sampleStep, sampleSteps, sampleWorkflows } from "@recnrun/domain/testing";
import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { App } from "@/app/App";
import type { ExtensionGateway } from "@/services/extension";
import { INSTALL_GUIDE_URL } from "@/ui/InstallBanner";
import { installedGateway, missingGateway } from "./fake-gateway.ts";

function mount(gateway: ExtensionGateway, hash = "#/") {
  window.location.hash = hash;
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App gateway={gateway} />, root);
  return root;
}

const texts = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((node) => node.textContent?.trim());

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

afterEach(() => {
  render(null, document.body);
  window.location.hash = "";
});

test("asks to install the extension when it is missing", async () => {
  const root = mount(missingGateway);
  await expect
    .poll(() => root.querySelector(".banner h2")?.textContent)
    .toBe("Install the RECnRun extension");
  expect(root.querySelector("a.button")?.getAttribute("href")).toBe(INSTALL_GUIDE_URL);
});

test("lists workflows with their status and tags, and filters them by tag", async () => {
  const root = mount(installedGateway({ workflows: sampleWorkflows() }));
  await expect.poll(() => root.querySelectorAll("article.workflow").length).toBe(2);
  expect(texts(root, "article.workflow h2")).toEqual([
    "Log in as admin",
    "Checkout with saved card",
  ]);
  expect(texts(root, "article.workflow .status")).toEqual(["Recording", "Stopped"]);
  expect(texts(root, "article.workflow:first-child .tag")).toEqual(["env:local", "feature:login"]);
  expect(root.querySelector('[data-testid="extension-version"]')?.textContent).toBe(
    "Extension 0.1.0",
  );
  const filter = root.querySelector<HTMLInputElement>("input[type=search]");
  if (!filter) throw new Error("No filter input.");
  filter.value = "env:ACC";
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  await expect.poll(() => texts(root, "article.workflow h2")).toEqual(["Checkout with saved card"]);
});

test("explains an empty extension and reports a failed read", async () => {
  const empty = mount(installedGateway());
  await expect
    .poll(() => empty.querySelector(".empty-state h2")?.textContent)
    .toBe("No workflows yet");
  const failed = mount(installedGateway(new Error("Quota exceeded")));
  await expect
    .poll(() => failed.querySelector(".empty-state p")?.textContent)
    .toBe("Quota exceeded");
});

test("deletes a stopped workflow and shows the stop button for the recording one", async () => {
  const gateway = installedGateway({ workflows: sampleWorkflows() });
  const root = mount(gateway);
  await expect.poll(() => root.querySelectorAll("article.workflow").length).toBe(2);
  expect(button(root, "Delete")).toBeDefined();
  button(root, "Delete")?.click();
  await expect.poll(() => texts(root, "article.workflow h2")).toEqual(["Log in as admin"]);
  expect(gateway.calls).toContainEqual({ type: "deleteWorkflow", payload: "wf-checkout" });
});

test("shows the current recording with a stop button and an allow button per missing origin", async () => {
  const [recording] = sampleWorkflows();
  const gateway = installedGateway({
    workflows: sampleWorkflows(),
    status: { workflow: recording, missingOrigins: ["http://localhost/*"] },
  });
  const root = mount(gateway);
  await expect
    .poll(() => root.querySelector(".recording-status")?.textContent)
    .toContain("Recording Log in as admin");
  button(root, "Allow access to http://localhost/*")?.click();
  await expect
    .poll(() => gateway.calls)
    .toContainEqual({ type: "grantOrigins", payload: ["http://localhost/*"] });
  gateway.emitStatus({ workflow: recording, missingOrigins: [] });
  await expect.poll(() => button(root, "Allow access to http://localhost/*")).toBeUndefined();
  button(root, "Stop")?.click();
  await expect.poll(() => gateway.calls).toContainEqual({ type: "stop", payload: "wf-login" });
  gateway.emitStatus({ missingOrigins: [] });
  await expect.poll(() => root.querySelector(".recording-status")).toBeNull();
});

test("shows a workflow's steps and appends live steps once", async () => {
  const gateway = installedGateway({ workflows: sampleWorkflows(), steps: sampleSteps() });
  const root = mount(gateway, "#/workflows/wf-login");
  await expect.poll(() => root.querySelectorAll("li.step").length).toBe(4);
  expect(root.querySelector("main h2")?.textContent).toBe("Log in as admin");
  expect(texts(root, "li.step .step-label")).toEqual([
    "navigate http://localhost:3000/login",
    "fill #email admin@example.com",
    "fill #password ***",
    'click [data-testid="sign-in"]',
  ]);
  expect(texts(root, "li.step:first-child time")).toEqual(["09:30:01"]);
  expect(texts(root, "li.step:first-child .author")).toEqual(["browser"]);
  const live = {
    ...sampleStep(),
    id: "step-5",
    recordedAt: "2026-10-01T09:30:09.000Z",
    command: "press",
    value: "Enter",
  };
  gateway.emitStep(live);
  gateway.emitStep(live);
  gateway.emitStep({ ...live, id: "step-6", workflowId: "wf-other" });
  await expect.poll(() => root.querySelectorAll("li.step").length).toBe(5);
  expect(root.querySelector("li.step:last-child .step-label")?.textContent).toBe("press Enter");
  expect(root.querySelector("a[href='#/']")).not.toBeNull();
});

test("updates a workflow's status in the list and on its timeline when the extension reports it", async () => {
  const [recording, stopped] = sampleWorkflows();
  if (!recording || !stopped) throw new Error("fixture");
  const gateway = installedGateway({ workflows: [recording] });
  const list = mount(gateway);
  await expect.poll(() => texts(list, "article.workflow .status")).toEqual(["Recording"]);
  gateway.emitWorkflow({ ...recording, status: "stopped" });
  gateway.emitWorkflow(stopped);
  await expect.poll(() => texts(list, "article.workflow .status")).toEqual(["Stopped", "Stopped"]);
  expect(texts(list, "article.workflow h2")).toEqual([
    "Checkout with saved card",
    "Log in as admin",
  ]);

  const timeline = mount(gateway, "#/workflows/wf-login");
  await expect.poll(() => timeline.querySelector("main .status")?.textContent).toBe("Recording");
  gateway.emitWorkflow({ ...recording, status: "stopped" });
  await expect.poll(() => timeline.querySelector("main .status")?.textContent).toBe("Stopped");
});

test("explains a workflow without steps and an unknown workflow id", async () => {
  const empty = mount(
    installedGateway({ workflows: sampleWorkflows() }),
    "#/workflows/wf-checkout",
  );
  await expect.poll(() => empty.querySelector(".empty-state h2")?.textContent).toBe("No steps yet");
  const unknown = mount(installedGateway({ workflows: sampleWorkflows() }), "#/workflows/nope");
  await expect
    .poll(() => unknown.querySelector(".empty-state h2")?.textContent)
    .toBe("Workflow not found");
});
