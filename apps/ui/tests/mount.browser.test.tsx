import type { Flow, FlowCatalogEntry, FlowManifest } from "@recnrun/protocol";
import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { App } from "@/app/App";
import { hrefOf, parseHash } from "@/app/routes";
import { mount } from "@/app/mount";
import { NOW, REVISION, fakeApi } from "./fake-api";

afterEach(() => {
  history.replaceState(null, "", location.pathname + location.search);
  document.head.querySelector('meta[name="recnrun-token"]')?.remove();
});

test("asks for the service when the page carries no token", () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mount(root);
  expect(root.querySelector("h1")?.textContent).toBe("RECnRun");
  expect(root.querySelector('[role="alert"]')?.textContent).toContain("npx @recnrun/cli open");
});

test("connects to the service named by the token meta tag", () => {
  document.head.insertAdjacentHTML("beforeend", '<meta name="recnrun-token" content="t">');
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mount(root);
  expect(root.querySelector('nav[aria-label="Main"]')).not.toBeNull();
  expect(root.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("no service");
});

test("leaves the page untouched when the root element is missing", () => {
  document.body.replaceChildren();
  expect(() => mount(null)).not.toThrow();
  expect(document.body.childElementCount).toBe(0);
});

test("parses every route and writes it back", () => {
  for (const hash of ["#/setup", "#/flows", "#/record", "#/flows/a%20b", "#/flows/x/run"]) {
    expect(hrefOf(parseHash(hash))).toBe(hash);
  }
  expect(parseHash("")).toEqual({ screen: "catalog" });
  expect(parseHash("#/flows/x/run")).toEqual({ screen: "run", flowId: "x" });
});

test("navigates between screens through the hash", async () => {
  const fake = fakeApi({ "flow.list": async () => ({ flows: [] }) });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App api={fake.api} />, root);
  await expect.element(page.getByRole("heading", { name: "Flows" })).toBeVisible();
  await page.getByRole("link", { name: "Setup" }).click();
  await expect
    .element(page.getByRole("link", { name: "Setup" }))
    .toHaveAttribute("aria-current", "page");
  expect(location.hash).toBe("#/setup");
});

test("opens a flow in the editor, then its run screen, and starts a recording", async () => {
  const entry = {
    id: "login",
    name: "Log in",
    status: "recorded",
    revision: REVISION,
    updatedAt: NOW,
  };
  const flow: Flow = {
    schemaVersion: 1,
    id: "login",
    name: "Log in",
    actors: {},
    inputs: {},
    requirements: [],
    preconditions: [],
    steps: [],
  };
  const manifest = { ...entry, revisions: [] } as unknown as FlowManifest;
  const fake = fakeApi({
    "flow.list": async () => ({ flows: [entry as FlowCatalogEntry] }),
    "flow.get": async () => ({ flow, manifest, revision: REVISION }),
    "profiles.list": async () => ({ profiles: [] }),
  });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App api={fake.api} />, root);
  await page.getByRole("button", { name: "Open Log in" }).click();
  await expect.element(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  expect(location.hash).toBe("#/flows/login");
  await page.getByRole("button", { name: "Run" }).click();
  await expect.element(page.getByRole("heading", { name: "Run Log in" })).toBeVisible();
  expect(location.hash).toBe("#/flows/login/run");
  await page.getByRole("link", { name: "Flows" }).click();
  await page.getByRole("button", { name: "New recording" }).click();
  await expect.element(page.getByRole("button", { name: "Start recording" })).toBeVisible();
  expect(location.hash).toBe("#/record");
});
