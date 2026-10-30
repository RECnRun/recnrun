import type { Page } from "@playwright/test";
import { appLog, requestsOf } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import { barrierLeft, incognitoWindows } from "./fixtures/identity.ts";
import { identity, newIdentity, opened } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { APP, pageAt, workspacePanel } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Waits until New identity returned, Close enabled or its failure shown, and requires no failure. */
async function openedWithoutAlert(site: Page) {
  const alert = workspacePanel(site).getByRole("alert");
  const close = identity(site, "A").getByRole("button", { name: "Close", disabled: false });
  await expect(alert.or(close)).toBeVisible();
  expect(await alert.allTextContents()).toEqual([]);
  await opened(site, "A");
}

// Logged out, Gmail answers its sign-in redirect with a type Chrome cannot render.
for (const { name, headers } of [
  { name: "a type Chrome cannot render", headers: "type=binary" },
  { name: "an attachment", headers: "type=binary&attachment=1" },
]) {
  test(`a sign-in redirect with ${name} opens the identity, and the release follows it`, async ({
    context,
    serviceWorker,
  }) => {
    const run = `binary-redirect-${Date.now()}`;
    const query = `to=other&${headers}&run=${run}`;
    const site = await openSite(context, "/");
    await newIdentity(site, `${APP}/app/redirect?${query}`);
    await openedWithoutAlert(site);
    await pageAt(context, `http://other.localhost:5192/app/?${query}`);
    expect(await incognitoWindows(serviceWorker)).toBe(1);
    expect(await barrierLeft(serviceWorker)).toEqual({ rules: 0, scripts: 0 });
    const entries = await appLog(run);
    const released = entries.findLastIndex(({ path }) => path === "/app/redirect");
    expect(requestsOf(entries.slice(released)).slice(0, 2)).toEqual([
      "/app/redirect document",
      "/app/ document",
    ]);
  });
}
