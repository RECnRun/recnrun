import { expect, type Page, type Request, test } from "@playwright/test";
import { openFlowStore } from "../../packages/persistence/src/index.ts";
import {
  FIXTURE_ORIGIN,
  homeWithChrome,
  removeHome,
  startServiceChild,
} from "./fixtures/local-service.ts";

const FLOW_ID = "hostile";
// apps/fixture/public/routes/hostile.js logs this only if a viewer runs its captured script.
const MARKER = "recnrun-viewer-marker";
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** A failing flow whose failure snapshot holds the fixture's hostile markup. */
async function seedFlow(home: string) {
  const store = await openFlowStore({ home });
  try {
    await store.saveFlow({
      schemaVersion: 1,
      id: FLOW_ID,
      name: "Hostile snapshot",
      actors: {},
      inputs: {},
      requirements: [],
      preconditions: [],
      steps: [
        { id: "open", action: "navigate", url: `${FIXTURE_ORIGIN}/routes/hostile` },
        { id: "missing", action: "click", target: { testId: "missing" }, timeoutMs: 1_000 },
      ],
    });
  } finally {
    store.close();
  }
}

/** Every console message of the UI page and its frames, and how each request ended. */
function observe(page: Page) {
  const messages: string[] = [];
  const outcomes = new Map<Request, string>();
  page.on("console", (message) => messages.push(message.text()));
  page.on("pageerror", (error) => messages.push(error.message));
  page.on("request", (request) => outcomes.set(request, "pending"));
  page.on("requestfinished", (request) => outcomes.set(request, "finished"));
  page.on("requestfailed", (request) =>
    outcomes.set(request, request.failure()?.errorText ?? "failed"),
  );
  return { messages, outcomes };
}

const hostOf = (url: string) => (url.startsWith("data:") ? "127.0.0.1" : new URL(url).hostname);

/**
 * Requests of the viewer frame or off loopback, with how they ended. Chrome reports a load its
 * Content Security Policy stopped as a request that failed with `csp`; it never left the browser.
 */
function attempts(page: Page, outcomes: ReadonlyMap<Request, string>) {
  return [...outcomes]
    .filter(
      ([request]) => request.frame() !== page.mainFrame() || !LOOPBACK.has(hostOf(request.url())),
    )
    .map(([request, outcome]) => ({ url: request.url(), outcome }));
}

const viewerUrls = (page: Page) =>
  page
    .frames()
    .filter((frame) => frame !== page.mainFrame())
    .map((frame) => frame.url());

/** Opens the failure snapshot's page in the viewer and presses its remote form's submit. */
async function viewAndSubmit(page: Page) {
  const failure = page.getByRole("listitem", { name: "Snapshot missing, failure" });
  await failure.getByRole("button", { name: "View page" }).click();
  const viewer = page.frameLocator('iframe[title="Captured page of missing, failure"]');
  await expect(viewer.getByRole("heading", { name: "Hostile markup" })).toBeVisible();
  await expect(viewer.getByTestId("remote-image")).toBeAttached();
  const before = viewerUrls(page);
  expect(before).toEqual(["about:srcdoc"]);
  await viewer.getByTestId("remote-submit").click();
  // A blocked submission fires no event to wait for, so its absence needs a window.
  await page.waitForTimeout(1_000);
  expect(viewerUrls(page)).toEqual(before);
}

test("a captured page renders in the viewer without running a script or fetching a file", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { home, chrome } = await homeWithChrome();
  await seedFlow(home);
  const service = await startServiceChild(home);
  const { messages, outcomes } = observe(page);
  try {
    await page.goto(`${service.url}#/flows/${FLOW_ID}/run`);
    await page.getByRole("button", { name: "Start run" }).click();
    const summary = page.getByRole("region", { name: "Run summary" });
    await expect(summary).toContainText("failed", { timeout: 60_000 });
    await viewAndSubmit(page);
    await page.screenshot({ path: testInfo.outputPath("viewer.png"), fullPage: true });

    expect(messages.filter((text) => text.includes(MARKER))).toEqual([]);
    const tried = attempts(page, outcomes);
    expect(tried.filter(({ outcome }) => outcome !== "csp")).toEqual([]);
    expect(tried.map(({ url }) => url)).toContain("http://remote.example/pixel.png");
  } finally {
    await page.goto("about:blank");
    await service.stop();
    await chrome.close();
    await removeHome(home);
  }
});
