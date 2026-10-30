import { expect, test } from "./fixtures/extension.ts";
import { incognitoWindows } from "./fixtures/identity.ts";
import { lifecycleSetUp } from "./fixtures/lifecycle.ts";
import { askBeforeLeaving } from "./fixtures/panel.ts";

test.use({ incognitoAccess: true });

test("a page that asks before it unloads neither blocks nor shows a dialog on New identity and Close", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  const a = await askBeforeLeaving(await next());

  await identities.open("B");
  expect(a).toEqual([]);
  const b = await askBeforeLeaving(await next());
  expect(await incognitoWindows(serviceWorker)).toBe(1);

  await identities.suspend();
  expect(b).toEqual([]);
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
});

test("a page that asks before it unloads does not block Switch to", async ({
  context,
  serviceWorker,
}) => {
  const { identities, next } = await lifecycleSetUp(context, serviceWorker);
  await identities.open("A");
  await next();
  await identities.open("B");
  const b = await askBeforeLeaving(await next());

  await identities.open("A");
  expect(b).toEqual([]);
  await next();
  expect(await incognitoWindows(serviceWorker)).toBe(1);
});
