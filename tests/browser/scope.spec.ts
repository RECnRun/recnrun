import type { BrowserContext, Page } from "@playwright/test";
import { startRecording } from "../../packages/adapter/src/index.ts";
import type { CapturedEvent } from "../../packages/protocol/src/index.ts";
import { expect, FIXTURE_ORIGIN, test, waitReady } from "./fixtures/fixture-app.ts";

async function targetIdOf(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  await session.detach();
  return targetInfo.targetId;
}

/** The Playwright page of a target another client opened. */
async function pageOf(context: BrowserContext, targetId: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      for (const page of context.pages()) if ((await targetIdOf(page)) === targetId) found = page;
      return found !== undefined;
    })
    .toBe(true);
  return found as Page;
}

async function typeName(page: Page, text: string): Promise<void> {
  await page.getByTestId("name").fill(text);
  await page.getByTestId("submit").click();
}

test("tabs outside the session scope produce no events", async ({ app, chrome }) => {
  const before = await app.open("form");
  const events: CapturedEvent[] = [];
  const recording = await startRecording(chrome.wsEndpoint, {
    capture: { runId: "scope-spec", onEvent: (event) => void events.push(event) },
  });
  let popupId = "";
  try {
    const root = await pageOf(app.context, recording.targetId);
    await root.goto(`${FIXTURE_ORIGIN}/routes/form`);
    await waitReady(root, "form");
    const after = await app.open("form");
    await typeName(before, "Before");
    await typeName(after, "After");
    const [popup] = await Promise.all([
      root.waitForEvent("popup"),
      root.evaluate(() => void window.open("/routes/form")),
    ]);
    await waitReady(popup, "form");
    popupId = await targetIdOf(popup);
    await typeName(root, "Session");
    await typeName(popup, "Popup");
    const submitted = (targetId: string) =>
      events.some((e) => e.targetId === targetId && e.category === "dom" && e.type === "submit");
    await expect.poll(() => submitted(recording.targetId) && submitted(popupId)).toBe(true);
    await recording.settled();
    const outside = new Set([await targetIdOf(before), await targetIdOf(after)]);
    expect(events.filter((e) => e.targetId !== null && outside.has(e.targetId))).toEqual([]);
  } finally {
    recording.stop();
  }
  const targets = new Set(events.flatMap((e) => (e.targetId === null ? [] : [e.targetId])));
  expect(targets).toEqual(new Set([recording.targetId, popupId]));
});
