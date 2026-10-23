import { emptySnapshot } from "@recnrun/domain";
import type { Snapshot } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { Dashboard } from "@/dashboard/Dashboard";
import { createHashRouter } from "@/dashboard/router";
import type { DashboardRouter } from "@/dashboard/router";

function memoryRouter(initialRoute = "/") {
  const listeners = new Set<(path: string) => void>();
  const published: { path: string; title: string }[] = [];
  const router: DashboardRouter = {
    initialRoute,
    href: (path) => `#${path}`,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (path, title) => published.push({ path, title }),
  };
  return { router, published, go: (path: string) => listeners.forEach((each) => each(path)) };
}

function mount(snapshot: Snapshot | Error, router: DashboardRouter = memoryRouter().router) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const loadSnapshot = async () => {
    if (snapshot instanceof Error) throw snapshot;
    return snapshot;
  };
  render(<Dashboard loadSnapshot={loadSnapshot} router={router} />, root);
  return root;
}

const headings = (root: HTMLElement) =>
  [...root.querySelectorAll("article.recording h3")].map((heading) => heading.textContent);

const workspaces = (root: HTMLElement) =>
  [...root.querySelectorAll("section.workspace > h2")].map((heading) => heading.textContent);

afterEach(() => {
  history.replaceState(null, "", location.pathname);
});

test("lists every recording, newest first, linked to its route", async () => {
  const root = mount(sampleSnapshot());
  await expect.poll(() => headings(root)).toEqual(["Checkout with saved card", "Log in as admin"]);
  expect(root.querySelector("article.recording .start-url")?.textContent).toBe(
    "https://staging.shop.example/cart",
  );
  expect(root.querySelector("article.recording h3 a")?.getAttribute("href")).toBe(
    "#/recordings/rec-checkout",
  );
});

test("groups the recordings under the site each one starts on", async () => {
  const root = mount(sampleSnapshot());
  await expect.poll(() => workspaces(root)).toEqual(["staging.shop.example", "localhost:3000"]);
});

test("explains that an empty extension has no recordings yet", async () => {
  const root = mount(emptySnapshot());
  await expect
    .poll(() => root.querySelector(".empty-state h2")?.textContent)
    .toBe("No recordings yet");
});

test("reports why the data could not be read", async () => {
  const root = mount(new Error("Quota exceeded"));
  await expect.poll(() => root.querySelector(".empty-state p")?.textContent).toBe("Quota exceeded");
});

test("opens a recording and goes back to the list", async () => {
  const { router, published } = memoryRouter();
  const root = mount(sampleSnapshot(), router);
  await expect.poll(() => headings(root)).toHaveLength(2);

  root.querySelector<HTMLAnchorElement>('a[href="#/recordings/rec-login"]')?.click();
  await expect.poll(() => headings(root)).toEqual(["Log in as admin"]);
  // Preact runs effects after paint, so the publish can trail the render.
  await expect
    .poll(() => published.at(-1))
    .toEqual({
      path: "/recordings/rec-login",
      title: "Log in as admin · RECnRun",
    });

  root.querySelector<HTMLAnchorElement>('a[href="#/"]')?.click();
  await expect.poll(() => headings(root)).toHaveLength(2);
  await expect.poll(() => published.at(-1)).toEqual({ path: "/", title: "RECnRun" });
});

test("follows routes the host changes, such as the Back button", async () => {
  const { router, go } = memoryRouter("/recordings/rec-checkout");
  const root = mount(sampleSnapshot(), router);
  await expect.poll(() => headings(root)).toEqual(["Checkout with saved card"]);
  go("/");
  await expect.poll(() => headings(root)).toHaveLength(2);
});

test("says when a linked recording does not exist", async () => {
  const root = mount(sampleSnapshot(), memoryRouter("/recordings/deleted").router);
  await expect
    .poll(() => root.querySelector(".empty-state h2")?.textContent)
    .toBe("Recording not found");
});

test("keeps the route in the tab's hash", async () => {
  history.replaceState(null, "", "#/recordings/rec-login");
  const router = createHashRouter();
  expect(router.initialRoute).toBe("/recordings/rec-login");
  expect(router.href("/")).toBe("#/");

  const seen: string[] = [];
  const stop = router.subscribe((path) => seen.push(path));
  router.publish("/recordings/rec-checkout", "Checkout with saved card · RECnRun");
  expect(location.hash).toBe("#/recordings/rec-checkout");
  expect(document.title).toBe("Checkout with saved card · RECnRun");
  await expect.poll(() => seen).toEqual(["/recordings/rec-checkout"]);
  stop();

  history.replaceState(null, "", location.pathname);
  expect(createHashRouter().initialRoute).toBe("/");
});
