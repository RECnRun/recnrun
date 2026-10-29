import type { Page, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";
import { dashboardOf, openSite } from "./fixtures/session.ts";

test.use({ incognitoAccess: true });

// Node may not resolve *.localhost, so specs reach the server through plain localhost.
const DOWN_SWITCH = "http://localhost:5192/__down";

/** Takes `origin`'s host down or back up: while down, every request to it drops its connection. */
async function siteDown(origin: string, down: boolean): Promise<void> {
  const response = await fetch(DOWN_SWITCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: new URL(origin).host, down }),
  });
  expect(response.ok).toBe(true);
}

/** Writes `label` into the origin's localStorage on its page in the managed tab. */
async function mark(page: Page, origin: string, label: string): Promise<void> {
  await page.goto(`${origin}/blank`);
  await page.evaluate((value) => localStorage.setItem("who", value), label);
  await page.goto(BLANK);
}

const held = async (page: Page, origin: string) => {
  await page.goto(`${origin}/blank`);
  return page.evaluate(() => localStorage.getItem("who"));
};

/** The notes the dashboard's row of `label` shows for the origins its identity left out. */
const notesOf = (site: Page, label: string) =>
  dashboardOf(site)
    .getByRole("list", { name: "Saved identities" })
    .getByRole("listitem", { name: label, exact: true })
    .locator(".identity-skipped");

/** The last operation the journal holds: its step, status, and the origins it left out. */
const lastOperation = (serviceWorker: Worker) =>
  serviceWorker.evaluate(async () => {
    const scope = globalThis as unknown as {
      chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } };
    };
    return (await scope.chrome.storage.local.get("workspace-operation"))["workspace-operation"];
  });

test("an origin that does not answer is skipped, named on its row, and kept until it answers again", async ({
  context,
  serviceWorker,
}) => {
  const down = "http://down1.localhost:5192";
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  const site = await openSite(context, "/");
  await identities.open("A");
  await mark(await next(), down, "A");
  await identities.open("B");
  await next();
  await siteDown(down, true);
  try {
    // A's start cannot restore the origin, yet A opens in one window, released as always.
    await identities.open("A");
    await next();
    expect(await incognitoWindows(serviceWorker)).toBe(1);
    const restored = { origin: down, work: "restore", step: "navigate", kept: true };
    expect(await lastOperation(serviceWorker)).toMatchObject({
      status: "done",
      skipped: [restored],
    });
    await expect(notesOf(site, "A")).toHaveText([
      `Not restored: storage of ${down} (the site did not answer).`,
    ]);
    await site.screenshot({ path: test.info().outputPath("not-restored-row.png") });

    // The window never held the origin, so A's save keeps what A last saved of it.
    await identities.open("B");
    await next();
    await expect(notesOf(site, "A")).toHaveText([
      `Not saved: storage of ${down} (the last start could not restore it); its last saved storage is kept.`,
    ]);
    await site.screenshot({ path: test.info().outputPath("kept-row.png") });
  } finally {
    await siteDown(down, false);
  }
  await identities.open("A");
  expect(await held(await next(), down)).toBe("A");
});

test("an origin first saved while it does not answer is named as not saved", async ({
  context,
  serviceWorker,
}) => {
  const down = "http://down2.localhost:5192";
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  const site = await openSite(context, "/");
  await identities.open("A");
  await mark(await next(), down, "A");
  await siteDown(down, true);
  try {
    // The root and then the last page are tried; neither answers, so the save goes on without it.
    await identities.open("B");
    await next();
    expect(await incognitoWindows(serviceWorker)).toBe(1);
    await expect(notesOf(site, "A")).toHaveText([
      `Not saved: storage of ${down} (the site did not answer).`,
    ]);
    await site.screenshot({ path: test.info().outputPath("not-saved-row.png") });
  } finally {
    await siteDown(down, false);
  }
  await identities.open("A");
  expect(await held(await next(), down)).toBeNull();
});
