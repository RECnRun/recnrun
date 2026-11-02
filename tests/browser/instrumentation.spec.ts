import type { Frame, Page } from "@playwright/test";
import { instrument, type Instrumentation } from "../../packages/adapter/src/index.ts";
import {
  HOOK_VERSION,
  type InstrumentationEvent,
  type InstrumentedTarget,
} from "../../packages/protocol/src/index.ts";
import {
  expect,
  FIXTURE_ORIGIN,
  SECOND_ORIGIN,
  state,
  test as appTest,
  waitReady,
} from "./fixtures/fixture-app.ts";

declare global {
  interface Window {
    __recnrunHook?: { version: number; installedAt: number; documentId: string };
    __recnrunObserver?: (message: string) => void;
  }
}

interface Instrumented {
  handle: Instrumentation;
  events: InstrumentationEvent[];
  /** The target whose document this page or frame runs, found through the hook's documentId. */
  targetOf: (context: Page | Frame) => Promise<InstrumentedTarget>;
}

const documentId = async (context: Page | Frame) =>
  (await context.evaluate(() => window.__recnrunHook?.documentId)) ?? "";

const hookSeenAtHead = (context: Page | Frame) =>
  context.evaluate(() => window.__fixture?.hookSeenAtHead);

const test = appTest.extend<{ instrumented: Instrumented }>({
  instrumented: async ({ app, chrome }, use, testInfo) => {
    void app;
    const events: InstrumentationEvent[] = [];
    const handle = await instrument(chrome.wsEndpoint, { onEvent: (event) => events.push(event) });
    const targetOf = async (context: Page | Frame) => {
      const id = await documentId(context);
      await expect.poll(() => events.some((event) => event.documentId === id)).toBe(true);
      const targetId = events.find((event) => event.documentId === id)?.targetId;
      const target = handle.report().targets.find((each) => each.targetId === targetId);
      if (!target) throw new Error(`No instrumented target for document ${id}`);
      return target;
    };
    try {
      await use({ handle, events, targetOf });
    } finally {
      const report = JSON.stringify(handle.report(), null, 2);
      console.log(`report() after "${testInfo.title}": ${JSON.stringify(handle.report())}`);
      await testInfo.attach("instrumentation-report", {
        body: report,
        contentType: "application/json",
      });
      handle.stop();
    }
  },
});

test("the hook runs before the first script on load, reload, and SPA navigation", async ({
  app,
  instrumented: { events, targetOf },
}) => {
  const page = await app.open("spa");
  expect((await state(page))?.hookSeenAtHead).toBe(true);
  const first = await documentId(page);
  const target = await targetOf(page);
  expect(target).toMatchObject({ type: "page", installMode: "before-first-script" });
  const installed = (id: string) => events.filter((event) => event.documentId === id);
  expect(installed(first)).toMatchObject([
    {
      type: "document.hook-installed",
      targetId: target.targetId,
      frameId: expect.any(String),
      installMode: "before-first-script",
      hookSeq: 1,
      url: `${FIXTURE_ORIGIN}/routes/spa`,
    },
  ]);

  const ofTarget = () => events.filter((event) => event.targetId === target.targetId);
  const before = ofTarget().length;
  await page.getByRole("link", { name: "View B" }).click();
  await expect(page.getByTestId("view")).toHaveText("View B");
  expect(await documentId(page), "pushState keeps the document").toBe(first);
  expect(ofTarget(), "pushState installs nothing again").toHaveLength(before);

  await page.reload();
  await waitReady(page, "spa");
  expect((await state(page))?.hookSeenAtHead).toBe(true);
  const second = await documentId(page);
  expect(second).not.toBe(first);
  await expect.poll(() => installed(second).length).toBe(1);
  expect(installed(second)[0]).toMatchObject({ targetId: target.targetId, seq: before + 1 });
});

test("same-origin and cross-site iframe children are hooked before their first script", async ({
  app,
  instrumented: { targetOf },
}) => {
  const page = await app.open("iframe");
  await expect(page.getByTestId("origin-same")).toHaveText(FIXTURE_ORIGIN);
  await expect(page.getByTestId("origin-cross")).toHaveText(SECOND_ORIGIN);
  const same = page
    .frames()
    .find((frame) => frame.url() === `${FIXTURE_ORIGIN}/routes/iframe-child`);
  const cross = page.frames().find((frame) => frame.url().startsWith(SECOND_ORIGIN));
  if (!same || !cross) throw new Error("The iframe children did not load.");
  expect(await hookSeenAtHead(same)).toBe(true);
  expect(await hookSeenAtHead(cross)).toBe(true);
  const parent = await targetOf(page);
  expect(await targetOf(same), "a same-origin child shares its parent's target").toEqual(parent);
  expect(await targetOf(cross), "the cross-site child is an OOPIF target").toMatchObject({
    type: "iframe",
    url: `${SECOND_ORIGIN}/routes/iframe-child`,
    installMode: "before-first-script",
    hookInstalled: true,
  });
});

test("a popup is attached and hooked before its first script", async ({
  app,
  instrumented: { events, targetOf },
}) => {
  const page = await app.open("popup");
  const opened = app.context.waitForEvent("page");
  await page.getByRole("button", { name: "Open popup" }).click();
  const popup = await opened;
  await waitReady(popup, "popup-child");
  expect((await state(popup))?.hookSeenAtHead).toBe(true);
  await expect(page.getByTestId("popup-report")).toHaveText(`Popup ready at ${FIXTURE_ORIGIN}`);
  const target = await targetOf(popup);
  expect(target).toMatchObject({
    type: "page",
    url: `${FIXTURE_ORIGIN}/routes/popup-child`,
    installMode: "before-first-script",
    hookInstalled: true,
  });
  // When Chrome hands the hooked about:blank window to the popup's document, it gets its own id.
  const installs = events.filter((event) => event.targetId === target.targetId);
  expect(installs.at(-1)).toMatchObject({
    url: `${FIXTURE_ORIGIN}/routes/popup-child`,
    documentId: await documentId(popup),
  });
  expect(new Set(installs.map((event) => event.documentId)).size).toBe(installs.length);
});

test("service and dedicated workers are observed and resumed", async ({
  app,
  instrumented: { handle },
}) => {
  const page = await app.open("service-worker");
  await expect(page.getByTestId("sw-state")).toHaveText("controlled");
  await page.getByRole("button", { name: "Fetch twice" }).click();
  await expect(page.getByTestId("cache-result")).toHaveText("first: network, second: cache");
  const workerPage = await app.open("worker");
  await workerPage.getByRole("button", { name: "Ping the worker" }).click();
  await expect(workerPage.getByTestId("worker-reply")).toHaveText("Worker replied: pong to ping");

  const report = handle.report();
  test.info().annotations.push({
    type: "dedicated workers",
    description: JSON.stringify(report.dedicatedWorkers),
  });
  expect(report.serviceWorkers).toEqual({ observed: true });
  expect(report.dedicatedWorkers).toEqual({ observed: true });
  const workers = report.targets.filter(({ type }) => type.endsWith("worker"));
  expect(workers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "service_worker", url: `${FIXTURE_ORIGIN}/sw.js` }),
      expect.objectContaining({
        type: "worker",
        url: `${FIXTURE_ORIGIN}/worker.js`,
        installMode: "before-first-script",
      }),
    ]),
  );
  for (const worker of workers) expect(worker.error, worker.url).toBeUndefined();
});

test("forged observer messages from the page are dropped and counted", async ({
  app,
  instrumented: { events, handle, targetOf },
}) => {
  const page = await app.open("form");
  const { targetId } = await targetOf(page);
  const before = events.length;
  await page.evaluate((hookVersion) => {
    const post = window.__recnrunObserver;
    if (!post) throw new Error("The observer binding is missing.");
    post(JSON.stringify({ garbage: true }));
    post(
      JSON.stringify({
        kind: "lifecycle",
        type: "document.hook-installed",
        seq: 2,
        documentId: window.__recnrunHook?.documentId,
        ts: performance.now(),
        targetId: "forged-target",
        payload: { url: location.href, hookVersion },
      }),
    );
  }, HOOK_VERSION);
  const counters = () => {
    const target = handle.report().targets.find((each) => each.targetId === targetId);
    return [target?.droppedInvalid, target?.droppedUnknownFrame];
  };
  await expect.poll(counters).toEqual([1, 1]);
  expect(events).toHaveLength(before);
});
