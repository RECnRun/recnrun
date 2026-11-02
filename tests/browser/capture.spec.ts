import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { CapturedEvent } from "../../packages/protocol/src/index.ts";
import {
  BODY_TIMEOUT_MS,
  expect,
  payloadOf,
  project,
  requestsTo,
  test,
  type Captured,
} from "./fixtures/capture.ts";
import { compose, FIXTURE_ORIGIN, networkResult, waitReady } from "./fixtures/fixture-app.ts";

const GOLDEN = new URL("./golden/capture-dom.json", import.meta.url);

// Selection changes are coalesced by Chrome on its own schedule, so their count is not stable.
const UNSTABLE = new Set(["selectionchange"]);

interface Scenario {
  route: string;
  /** The last event type the interactions produce; the projection is read once it arrives. */
  last: string;
  act: (page: Page) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  form: {
    route: "form",
    last: "submit",
    act: async (page) => {
      await page.getByTestId("name").click();
      await page.getByTestId("name").pressSequentially("Ada");
      await page.getByTestId("plan").selectOption("pro");
      await page.getByTestId("terms").check();
      await page.getByTestId("contact-email").check();
      await page.getByTestId("submit").click();
    },
  },
  ime: {
    route: "ime",
    last: "compositionend",
    act: async (page) => {
      await page.getByTestId("ime-input").click();
      await compose(page, "日本");
    },
  },
  "virtual-list": {
    route: "virtual-list",
    last: "scroll",
    act: async (page) => {
      await page.getByTestId("list").hover();
      await page.mouse.wheel(0, 600);
    },
  },
  dialogs: {
    route: "dialogs",
    last: "dialog-closed",
    act: async (page) => {
      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByTestId("alert").click();
    },
  },
};

async function domOf(captured: Captured, page: Page, last: string): Promise<string[]> {
  const targetId = await captured.targetOf(page);
  const dom = () =>
    captured.events.filter((event) => event.category === "dom" && event.targetId === targetId);
  await expect.poll(() => dom().some((event) => event.type === last)).toBe(true);
  await captured.handle.settled();
  return dom()
    .filter((event) => !UNSTABLE.has(event.type))
    .map(project);
}

test("scripted interactions produce the golden DOM events, and the journal reads back", async ({
  app,
  captured,
}, testInfo) => {
  const actual: Record<string, string[]> = {};
  for (const [name, { route, last, act }] of Object.entries(SCENARIOS)) {
    const page = await app.open(route);
    await act(page);
    actual[name] = await domOf(captured, page, last);
  }
  await testInfo.attach("capture-dom.actual.json", {
    body: `${JSON.stringify(actual, null, 2)}\n`,
    contentType: "application/json",
  });
  expect(actual).toEqual(JSON.parse(await readFile(GOLDEN, "utf8")));
  const selections = captured.events.filter((event) => event.type === "selectionchange");
  expect(
    selections.length,
    "selection changes are captured, only left out of the golden file",
  ).toBeGreaterThan(0);
  const journal = await captured.finish();
  expect(journal.gap).toBeUndefined();
  expect(journal.events).toEqual(captured.events);
  expect(captured.handle.report().capture).toEqual({ events: journal.events.length, dropped: 0 });
});

const bodiesOf = (group: CapturedEvent[]) => group.filter((event) => event.type === "body");

async function settledRequest(captured: Captured, path: string): Promise<CapturedEvent[]> {
  const group = () => requestsTo(captured.events, path)[0] ?? [];
  await expect.poll(() => bodiesOf(group()).length, { timeout: 15_000 }).toBe(1);
  return group();
}

test("a JSON response body is captured, and a 500 keeps its status, body, and log entry", async ({
  app,
  captured,
}) => {
  const ok = await app.open("network");
  expect(await networkResult(ok, "json")).toBe("200 alpha, beta, gamma");
  const json = await settledRequest(captured, "/api/json");
  expect(payloadOf(json, "response")).toMatchObject({ status: 200, mimeType: "application/json" });
  expect(bodiesOf(json)[0]?.payload).toMatchObject({ condition: "captured", base64Encoded: false });
  expect(JSON.parse(String(bodiesOf(json)[0]?.payload.body))).toMatchObject({ ok: true });
  await ok.close();
  captured.events.length = 0;
  const failing = await app.open("network", "?fail=api-500");
  expect(await networkResult(failing, "json")).toMatch(/^500 /);
  const error = await settledRequest(captured, "/api/json?fail=api-500");
  expect(payloadOf(error, "response")).toMatchObject({ status: 500 });
  expect(bodiesOf(error)[0]?.payload).toMatchObject({
    condition: "captured",
    body: expect.stringContaining("Injected failure (fail=api-500)"),
  });
  const requestId = payloadOf(error, "request")?.requestId;
  await expect
    .poll(() => captured.events.filter((event) => event.type === "log").map((e) => e.payload))
    .toContainEqual(
      expect.objectContaining({ source: "network", level: "error", networkRequestId: requestId }),
    );
});

test("a fetch through three redirects records each hop in the chain", async ({ app, captured }) => {
  const page = await app.open("network");
  expect(await networkResult(page, "redirect")).toBe("200 redirected to /api/json");
  const chain = await settledRequest(captured, "/api/redirect/3");
  const hop = (hops: number) => ({
    url: `${FIXTURE_ORIGIN}/api/redirect/${hops}`,
    method: "GET",
    status: 302,
  });
  expect(chain.filter((event) => event.type === "request").at(-1)?.payload).toMatchObject({
    url: `${FIXTURE_ORIGIN}/api/json`,
    redirectChain: [hop(3), hop(2), hop(1)],
  });
  expect(payloadOf(chain, "response")).toMatchObject({
    url: `${FIXTURE_ORIGIN}/api/json`,
    status: 200,
  });
});

test("a form POST answered 303 records the redirect, the landing page, and its navigation", async ({
  app,
  captured,
}) => {
  const page = await app.open("submit-redirect");
  await page.getByTestId("name").fill("Ada");
  await page.getByTestId("send").click();
  await waitReady(page, "submit-result");
  const submit = await settledRequest(captured, "/api/submit");
  const landing = submit.filter((event) => event.type === "request").at(-1);
  expect(landing?.payload).toMatchObject({
    url: expect.stringContaining(`${FIXTURE_ORIGIN}/routes/submit-result?name=Ada`),
    method: "GET",
    resourceType: "Document",
    redirectChain: [{ url: `${FIXTURE_ORIGIN}/api/submit`, method: "POST", status: 303 }],
  });
  expect(payloadOf(submit, "response")).toMatchObject({ status: 200, mimeType: "text/html" });
  expect(bodiesOf(submit)[0]?.payload).toMatchObject({ condition: "captured" });
  await expect
    .poll(() =>
      captured.events
        .filter((event) => event.category === "navigation" && event.type === "committed")
        .map((event) => String(event.payload.url)),
    )
    .toContainEqual(expect.stringContaining("/routes/submit-result?name=Ada"));
});

test("a stream still loading at the deadline has an unavailable body with its reason", async ({
  app,
  captured,
}) => {
  const page = await app.open("network", "?fail=slow");
  await page.getByTestId("fetch-stream").click();
  const stream = await settledRequest(captured, "/api/stream?fail=slow");
  expect(bodiesOf(stream)[0]?.payload).toMatchObject({
    condition: "unavailable",
    reason: `The response was still loading after ${BODY_TIMEOUT_MS} ms.`,
  });
});

test("console errors, unhandled rejections, and exceptions name their document", async ({
  app,
  captured,
}) => {
  const page = await app.open("console");
  const documentId = await captured.documentOf(page);
  const targetId = await captured.targetOf(page);
  for (const name of ["error", "reject", "throw"]) await page.getByTestId(name).click();
  const of = (category: string) =>
    captured.events.filter(
      (event) => event.category === category && event.documentId === documentId,
    );
  await expect.poll(() => of("error").length).toBe(2);
  expect(of("console").filter((event) => event.type === "api")).toMatchObject([
    { payload: { level: "error", args: ["Fixture error message"] } },
  ]);
  expect(
    of("error").map((event) => (event.payload as { description?: string }).description),
  ).toEqual([
    expect.stringContaining("Rejected on purpose"),
    expect.stringContaining("Uncaught on purpose"),
  ]);
  await page.close();
  await expect
    .poll(() =>
      captured.events.some((event) => event.type === "detached" && event.targetId === targetId),
    )
    .toBe(true);
});

test("events inside a same-origin iframe and a cross-site OOPIF carry their own frame and target", async ({
  app,
  captured,
}) => {
  const page = await app.open("iframe");
  await expect(page.getByTestId("origin-cross")).not.toHaveText("waiting");
  const pageTarget = await captured.targetOf(page);
  const clicks: CapturedEvent[] = [];
  for (const name of ["frame-same", "frame-cross"]) {
    const frame = page.frameLocator(`[data-testid="${name}"]`);
    await frame.getByTestId("child-button").click();
    const handle = await page.getByTestId(name).elementHandle();
    const child = await handle?.contentFrame();
    if (!child) throw new Error(`No frame for ${name}`);
    const documentId = await captured.documentOf(child);
    const click = () =>
      captured.events.find((event) => event.type === "click" && event.documentId === documentId);
    await expect.poll(click).toBeDefined();
    clicks.push(click() as CapturedEvent);
  }
  const [same, cross] = clicks;
  expect(same).toMatchObject({
    targetId: pageTarget,
    payload: { target: { testId: "child-button" } },
  });
  expect(same?.frameId).not.toBe(pageTarget);
  expect(cross?.targetId).not.toBe(pageTarget);
  expect(cross).toMatchObject({ frameId: cross?.targetId, payload: { isTrusted: true } });
  expect(
    captured.events.find(
      (event) => event.type === "attached" && event.targetId === cross?.targetId,
    ),
  ).toMatchObject({ payload: { type: "iframe" } });
});
