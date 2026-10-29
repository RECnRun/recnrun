import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoLayout, shapeOf, tabSession, writeTabSession } from "./fixtures/layout.ts";
import { newIdentity, opened, switchTo } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { chromeTabs, startLoading } from "./fixtures/tabs.ts";
import { pageAt } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

const NEXT = "http://other.localhost:5192/blank?tab=next";

test("a Switch while a tab still loads its next page saves that page, and A comes back on it", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  await newIdentity(site, BLANK);
  await opened(site, "A");
  const main = await pageAt(context, BLANK);
  await writeTabSession(main, "main on app");
  // Busy on leaving, the page keeps its next one from committing for a second.
  await main.evaluate(() => {
    addEventListener("beforeunload", () => {
      const end = Date.now() + 1_000;
      while (Date.now() < end);
    });
  });
  const tab = (await chromeTabs(serviceWorker)).find(
    ({ incognito, url }) => incognito && url === BLANK,
  );
  if (tab?.id === undefined) throw new Error("A's tab is not open.");
  await startLoading(serviceWorker, tab.id, NEXT);
  await newIdentity(site, BLANK);
  await opened(site, "B");
  await switchTo(site, "A");
  await opened(site, "A");
  const back = [{ focused: expect.any(Boolean), tabs: [{ url: NEXT, active: true }] }];
  await expect.poll(async () => shapeOf(await incognitoLayout(serviceWorker))).toEqual(back);
  const next = await pageAt(context, NEXT);
  await next.goto(BLANK);
  expect(await tabSession(next)).toBe("main on app");
});
