import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { App } from "@/app/App";
import { hrefOf, parseHash } from "@/app/routes";
import { mount } from "@/app/mount";
import { fakeApi } from "./fake-api";

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
