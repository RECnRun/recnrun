import { agentLinkTabs, openAgentLinkTabs, watchAgentLinks } from "./fixtures/agent-links.ts";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import { delayStep } from "./fixtures/identity.ts";
import { newIdentity, opened, switchTo } from "./fixtures/panel.ts";
import { openSite } from "./fixtures/session.ts";
import { openTabIn } from "./fixtures/tabs.ts";
import { APP, managedWindow } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Long enough to open another tab of the origin while the start waits before its restore. */
const HOLD = 1_500;

test("an agent link no wait asked for is ended at once, and none stays open after the Switch", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  await newIdentity(site, BLANK);
  await opened(site, "A");
  await newIdentity(site, BLANK);
  await opened(site, "B");

  await watchAgentLinks(serviceWorker);
  await delayStep(serviceWorker, "restore", HOLD);
  const switched = switchTo(site, "A");
  // The new managed tab's agent connects behind the barrier, then the start waits before its restore.
  const before = await managedWindow(serviceWorker);
  await expect
    .poll(async () => {
      const managed = await managedWindow(serviceWorker);
      const links = await agentLinkTabs(serviceWorker);
      return managed?.generation !== before?.generation && links.includes(managed?.tabId);
    })
    .toBe(true);
  const windowId = (await managedWindow(serviceWorker))?.windowId ?? -1;
  // The barrier's agent is registered for the whole origin, so this page opens a link too.
  const other = await openTabIn(serviceWorker, windowId, `${APP}/blank?tab=other`);
  await expect.poll(() => agentLinkTabs(serviceWorker)).toContain(other);
  expect(await openAgentLinkTabs(serviceWorker, other)).toEqual([]);
  await switched;
  await delayStep(serviceWorker, "restore", 0);
  await opened(site, "A");

  expect(await openAgentLinkTabs(serviceWorker)).toEqual([]);
});
