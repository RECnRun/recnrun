import type { Frame, Page } from "@playwright/test";
import { startPicker } from "../../packages/adapter/src/index.ts";
import type { DomTarget } from "../../packages/protocol/src/index.ts";
import { counters, expect, SECOND_ORIGIN, test } from "./fixtures/fixture-app.ts";

declare global {
  interface Window {
    __captured?: string[];
  }
}

type Box = { x: number; y: number; width: number; height: number } | null;

const INPUT = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "auxclick",
  "contextmenu",
];

async function targetIdOf(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  await session.detach();
  return targetInfo.targetId;
}

/** Notes every input event that window and document capture listeners receive. */
function listenAtTheTop(context: Page | Frame): Promise<void> {
  return context.evaluate((types) => {
    window.__captured = [];
    for (const type of types) {
      const note = (where: string) => () => window.__captured?.push(`${where}:${type}`);
      window.addEventListener(type, note("window"), true);
      document.addEventListener(type, note("document"), true);
    }
  }, INPUT);
}

const captured = (context: Page | Frame) => context.evaluate(() => window.__captured ?? []);

/** Clicks the middle of `box` with each button; Chrome's inspect mode picks on any of them. */
async function clickEachButton(page: Page, box: Box): Promise<void> {
  if (!box) throw new Error("The element has no box.");
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.mouse.click(x, y, { button: "right" });
  await page.mouse.click(x, y, { button: "middle" });
}

async function pickerOn(page: Page, endpoint: string) {
  const picked: DomTarget[] = [];
  const picker = await startPicker(endpoint, await targetIdOf(page), {
    onPicked: (target) => picked.push(target),
  });
  return { picked, picker };
}

test("picking an element reaches no window or document capture listener", async ({
  app,
  chrome,
}) => {
  const page = await app.open("form");
  await listenAtTheTop(page);
  const { picked, picker } = await pickerOn(page, chrome.wsEndpoint);
  try {
    await clickEachButton(page, await page.getByTestId("submit").boundingBox());
    await expect.poll(() => picked.length).toBeGreaterThan(0);
    expect(await captured(page)).toEqual([]);
    expect((await counters(page)).clicks ?? 0).toBe(0);
    await expect.poll(() => picked.length).toBe(3);
    expect(new Set(picked.map((target) => JSON.stringify(target)))).toEqual(
      new Set([JSON.stringify({ tag: "button", testId: "submit", inputType: "submit" })]),
    );
  } finally {
    await picker.stop();
  }
  // Once picking stops, the same listeners hear the page's input again.
  await page.mouse.click(1, 1);
  expect(await captured(page)).toContain("document:click");
});

test("picking over a cross-site frame reaches none of its listeners", async ({ app, chrome }) => {
  const page = await app.open("iframe");
  const child = () => page.frames().find((frame) => frame.url().startsWith(SECOND_ORIGIN));
  const ready = async () => (await child()?.evaluate(() => window.__fixture?.ready)) === true;
  await expect.poll(ready).toBe(true);
  const frame = child() as Frame;
  await listenAtTheTop(frame);
  const { picked, picker } = await pickerOn(page, chrome.wsEndpoint);
  const button = page.frameLocator('[data-testid="frame-cross"]').getByTestId("child-button");
  try {
    await clickEachButton(page, await button.boundingBox());
    await expect.poll(() => picked.length).toBeGreaterThan(0);
    expect(await captured(frame)).toEqual([]);
    expect(await frame.evaluate(() => window.__fixture?.counters.clicks)).toBe(0);
    await expect.poll(() => picked.length).toBe(3);
  } finally {
    await picker.stop();
  }
  // Once picking stops, the same listeners hear the frame's input again.
  await button.click();
  expect(await captured(frame)).toContain("document:click");
});
