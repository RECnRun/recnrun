import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures/extension.ts";
import { letJoin, pairAll } from "./fixtures/folder.ts";
import { test } from "./fixtures/native-dialogs.ts";
import { framesOf, peerLine, peerStatus, profileIdOf, sendRaw } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";
import { clickToOpenPanel } from "./fixtures/session.ts";
import { storedSession } from "./fixtures/tabs.ts";

/*
 * Three profiles pair through one folder into a mesh, one link per pair, and each dashboard
 * shows the other two under their names.
 */

/** A tab of the profile's own, at an address that names it; the privacy policy has no frame. */
async function openIn(profile: Profile): Promise<Page> {
  const page = await profile.context.newPage();
  await page.goto(`/privacy/?${profile.name.replace(" ", "-")}`);
  return page;
}

/** The profile's list of `other`'s tabs, as its dashboard heads it. */
const listOf = (profile: Profile, other: Profile, state = "Connected") =>
  profile.dashboard.getByRole("complementary", { name: `Chrome — ${other.name} (${state})` });

const tabIn = (list: ReturnType<typeof listOf>, url: string) =>
  list.getByRole("listitem").filter({ hasText: url });

const clickLine = (profile: Profile, other: Profile, name: string) =>
  peerLine(profile, other).getByRole("button", { name }).click();

test("three profiles link pairwise, list each other's tabs, and Disconnect or a quit ends one pair only", async ({
  profileA,
  profileB,
  profileC,
  native,
}) => {
  test.setTimeout(240_000);
  const all = [profileA, profileB, profileC];
  await pairAll(all, native);
  const pages = await Promise.all(all.map(openIn));
  for (const profile of all) {
    for (const [index, other] of all.entries()) {
      if (other === profile) continue;
      await expect(tabIn(listOf(profile, other), pages[index]?.url() ?? "")).toBeVisible();
    }
  }

  await clickLine(profileA, profileB, "Disconnect");
  await expect(peerStatus(profileA, profileB)).toHaveText("Disconnected — Profile B");
  await expect(peerStatus(profileB, profileA)).toHaveText("Disconnected by Profile A");
  for (const [one, other] of [
    [profileA, profileC],
    [profileB, profileC],
  ] as const) {
    await expect(peerStatus(one, other)).toHaveText(`Connected — ${other.name}`);
    await expect(peerStatus(other, one)).toHaveText(`Connected — ${one.name}`);
  }
  await clickLine(profileA, profileB, "Reconnect");
  // Their folder grants ended with their windows (H2), so each allows the folder once more.
  await expect(peerLine(profileA, profileB).getByRole("button", { name: "Reconnect" })).toHaveCount(
    0,
  );
  for (const profile of [profileA, profileB]) await letJoin(profile, native);
  await expect(peerStatus(profileA, profileB)).toHaveText("Connected — Profile B", {
    timeout: 30_000,
  });
  await expect(peerStatus(profileB, profileA)).toHaveText("Connected — Profile A");

  await profileC.context.close();
  // No close message comes from a browser that quits; its heartbeats stop.
  for (const profile of [profileA, profileB]) {
    await expect(peerStatus(profile, profileC)).toHaveText(
      /^(Disconnected|Not reachable) — Profile C$/,
      { timeout: 5_000 },
    );
  }
  await expect(peerStatus(profileA, profileB)).toHaveText("Connected — Profile B");
});

/** The types of the frames `profile`, as `me`, sent to `to` since the tap held `from` frames. */
const sentTo = async (profile: Profile, me: string, to: string | undefined, from: number) =>
  (await framesOf(profile))
    .slice(from)
    .filter((frame) => frame.startsWith("{"))
    .map((frame) => JSON.parse(frame) as { type: string; from: string; to: string })
    .filter((message) => message.from === me && (to === undefined || message.to === to))
    .map((message) => message.type);

test("a session one profile runs in another blocks Record in the third, and a frame claiming another profile's id gets no answer", async ({
  profileA,
  profileB,
  profileC,
  native,
}) => {
  test.setTimeout(240_000);
  await pairAll([profileA, profileB, profileC], native);
  const inC = await openIn(profileC);
  const records = (dashboard: Page | Locator) => dashboard.getByRole("button", { name: "Record" });
  const record = records(tabIn(listOf(profileA, profileC), inC.url()));
  await clickToOpenPanel(profileA.context, record);
  await expect
    .poll(() => storedSession(profileC.serviceWorker))
    .toMatchObject({ status: "recording" });
  await expect(records(profileB.dashboard)).toHaveCount(0);
  await expect(profileB.dashboard.getByText("Recording in Profile C")).toHaveCount(3);

  // A frame on A's own link to C that claims to come from B: C drops it and answers nothing.
  const [idA, idB, idC] = [
    await profileIdOf(profileA),
    await profileIdOf(profileB),
    await profileIdOf(profileC),
  ];
  const before = (await framesOf(profileC)).length;
  const forged = {
    channel: "recnrun-peer",
    protocol: 1,
    id: crypto.randomUUID(),
    from: idB,
    to: idC,
    type: "ACTIVATE_TAB",
    tabId: 1,
  };
  await sendRaw(profileA, idC, JSON.stringify(forged));
  // A malformed frame after it gets an ERROR, so C has handled the forged one by then.
  await sendRaw(profileA, idC, "not json");
  await expect.poll(() => sentTo(profileC, idC, idA, before)).toContain("ERROR");
  // Tab and session notices go on to both; no answer to a command goes to either.
  expect(await sentTo(profileC, idC, undefined, before)).not.toContain("COMMAND_RESULT");
});
