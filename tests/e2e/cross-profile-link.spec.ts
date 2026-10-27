import { expect } from "./fixtures/extension.ts";
import { allowFolder, pair } from "./fixtures/folder.ts";
import { test } from "./fixtures/native-dialogs.ts";
import { framesOf, linkStatus, pairingSection, reopen, sendRaw } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";

interface ChromeGlobal {
  chrome: {
    storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
    runtime: { id: string; sendMessage(message: unknown): Promise<unknown> };
  };
}

const identityOf = (profile: Profile) =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    const { profileIdentity } = await chrome.storage.local.get("profileIdentity");
    return { identity: profileIdentity as { profileId: string }, extensionId: chrome.runtime.id };
  });

const typesOf = (frames: string[]) =>
  frames.map((frame) => (JSON.parse(frame) as { type: string }).type);

/** Clicks one of the pairing section's buttons in the profile's dashboard. */
const clickPairing = (profile: Profile, name: string) =>
  pairingSection(profile.dashboard).getByRole("button", { name }).click();

test("two profiles pair from their dashboards and exchange their tabs over the link", async ({
  profileA,
  profileB,
  native,
}) => {
  await pair(profileA, profileB, native);
  for (const [profile, other] of [
    [profileA, profileB],
    [profileB, profileA],
  ] as const) {
    const heading = `Chrome — ${other.name} (Connected)`;
    // The other profile's own tab, as its background reported it over the link.
    const tabs = profile.dashboard.getByRole("complementary", { name: heading });
    await expect(tabs.getByRole("listitem").filter({ hasText: other.site.url() })).toBeVisible();
    const types = typesOf(await framesOf(profile));
    expect(types).toEqual(expect.arrayContaining(["HELLO", "GET_TABS", "TABS_SNAPSHOT"]));
  }
});

test("each profile has its own id, not the extension's, kept across a restart", async ({
  profileA,
  profileB,
  launch,
}) => {
  const a = await identityOf(profileA);
  const b = await identityOf(profileB);
  expect(a.identity.profileId).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.identity.profileId).not.toBe(b.identity.profileId);
  expect(a.identity.profileId).not.toContain(a.extensionId);
  // The same unpacked path gives both profiles the same extension id.
  expect(a.extensionId).toBe(b.extensionId);

  await profileA.context.close();
  const restarted = await launch(profileA.dir);
  const worker = restarted.serviceWorkers()[0] ?? (await restarted.waitForEvent("serviceworker"));
  const again = await worker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return (await chrome.storage.local.get("profileIdentity")).profileIdentity;
  });
  expect(again).toEqual(a.identity);
});

test("a malformed or forged frame runs nothing and gets no answer it could use", async ({
  profileA,
  profileB,
  native,
}) => {
  await pair(profileA, profileB, native);
  const before = (await framesOf(profileB)).length;
  const idB = (await identityOf(profileB)).identity.profileId;
  await sendRaw(profileA, idB, "not json");
  // A well-formed message from a profile B never accepted: dropped without an answer.
  const forged = {
    channel: "recnrun-peer",
    protocol: 1,
    id: crypto.randomUUID(),
    from: crypto.randomUUID(),
    to: idB,
    type: "ACTIVATE_TAB",
    tabId: 1,
  };
  await sendRaw(profileA, idB, JSON.stringify(forged));
  // The tap holds frames both ways; B's own are the ones from its profile id.
  const sentByB = async () =>
    (await framesOf(profileB))
      .slice(before)
      .filter((frame) => frame.startsWith("{"))
      .map((frame) => JSON.parse(frame) as { type: string; from: string })
      .filter((message) => message.from === forged.to)
      .map((message) => message.type);
  await expect.poll(sentByB).toEqual(["ERROR"]);
  await expect.poll(async () => (await framesOf(profileB)).length).toBe(before + 3);
  expect(await sentByB()).toEqual(["ERROR"]);
  await expect(linkStatus(profileB)).toHaveText("Connected — Profile A");
});

const pinnedPeer = (profile: Profile) =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return (await chrome.storage.local.get("authorizedPeers")).authorizedPeers;
  });

test("a profile that quits drops the link, and after a restart reconnects as itself", async ({
  profileA,
  profileB,
  native,
  launch,
}) => {
  test.setTimeout(150_000);
  await pair(profileA, profileB, native);
  const pinned = await pinnedPeer(profileA);
  await profileB.context.close();
  // No close message comes from a browser that quits; its heartbeat stops, well before ICE gives up.
  await expect(linkStatus(profileA)).toHaveText(/^(Disconnected|Not reachable) — Profile B$/, {
    timeout: 5_000,
  });

  // A's dashboard kept its folder grant (H2); B's ended with its browser, so B allows it again.
  const restarted = await reopen(profileB, await launch(profileB.dir));
  expect(await allowFolder(restarted, native)).toBe("restore");
  await expect(linkStatus(profileA)).toHaveText("Connected — Profile B", { timeout: 90_000 });
  await expect(linkStatus(restarted)).toHaveText("Connected — Profile A");
  // The same certificate after the restart: the pinned peer is unchanged.
  expect(await pinnedPeer(profileA)).toEqual(pinned);
});

test("disconnect and forget end the link on both sides", async ({ profileA, profileB, native }) => {
  await pair(profileA, profileB, native);
  await clickPairing(profileA, "Disconnect");
  await expect(linkStatus(profileA)).toHaveText("Disconnected — Profile B");
  await expect(linkStatus(profileB)).toHaveText("Disconnected by Profile A");
  await clickPairing(profileB, "Forget Profile A");
  await expect(linkStatus(profileB)).toHaveText("Not paired");
});

test("a profile that disconnects tells the other, whose dashboard says so instead of an error", async ({
  profileA,
  profileB,
  native,
}) => {
  await pair(profileA, profileB, native);
  const heading = (state: string) =>
    profileB.dashboard.getByRole("heading", { name: `Chrome — Profile A (${state})` });
  await expect(heading("Connected")).toBeVisible();
  await clickPairing(profileA, "Disconnect");
  await expect(heading("Disconnected by Profile A")).toBeVisible();
  await expect(linkStatus(profileB)).toHaveText("Disconnected by Profile A");
});
