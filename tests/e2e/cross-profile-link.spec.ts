import { expect } from "./fixtures/extension.ts";
import { dashboardIn, framesOf, pair, test } from "./fixtures/profiles.ts";
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

/** Sends a raw frame over the link from a profile's background, as a faulty peer would. */
const sendRaw = (profile: Profile, frame: string) =>
  profile.serviceWorker.evaluate(
    (raw) =>
      (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage({
        target: "offscreen",
        command: { type: "send", frame: raw },
      }),
    frame,
  );

const typesOf = (frames: string[]) =>
  frames.map((frame) => (JSON.parse(frame) as { type: string }).type);

test("two profiles pair by hand and answer each other's ping", async ({ profileA, profileB }) => {
  await pair(profileA, profileB);
  for (const profile of [profileA, profileB]) {
    await profile.pairing.getByRole("button", { name: "Send ping" }).click();
    await expect(profile.pairing.getByText(/^Pong in \d+ ms$/)).toBeVisible();
  }
  const sentByA = typesOf(await framesOf(profileA));
  expect(sentByA).toEqual(expect.arrayContaining(["HELLO", "PING", "PONG", "SESSION_STATUS"]));
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
}) => {
  await pair(profileA, profileB);
  const before = (await framesOf(profileB)).length;
  await sendRaw(profileA, "not json");
  // A well-formed message from a profile B never accepted: dropped without an answer.
  const forged = {
    channel: "recnrun-peer",
    protocol: 1,
    id: crypto.randomUUID(),
    from: crypto.randomUUID(),
    to: (await identityOf(profileB)).identity.profileId,
    type: "ACTIVATE_TAB",
    tabId: 1,
  };
  await sendRaw(profileA, JSON.stringify(forged));
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
  await expect(profileB.pairing.getByRole("status")).toHaveText("Connected — Profile A");
});

const pinnedPeer = (profile: Profile) =>
  profile.serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    return (await chrome.storage.local.get("authorizedPeer")).authorizedPeer;
  });

test("a profile that quits drops the link, and after a restart pairs again as itself", async ({
  profileA,
  profileB,
  launch,
}) => {
  await pair(profileA, profileB);
  const pinned = await pinnedPeer(profileA);
  await profileB.context.close();
  // No close message comes from a browser that quits; ICE consent checks find it gone.
  await expect(profileA.pairing.getByRole("status")).toHaveText(
    /^(Disconnected|Not reachable) — Profile B$/,
    { timeout: 45_000 },
  );

  // Without a signaling server nothing reconnects on its own: the users pair again.
  const context = await launch(profileB.dir);
  const serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const pairing = await context.newPage();
  await pairing.goto(`chrome-extension://${new URL(serviceWorker.url()).host}/pairing.html`);
  await pair(profileA, { ...profileB, context, serviceWorker, pairing });
  // The same certificate after the restart: the pinned peer is unchanged.
  expect(await pinnedPeer(profileA)).toEqual(pinned);
});

test("disconnect and forget end the link on both sides", async ({ profileA, profileB }) => {
  await pair(profileA, profileB);
  await profileA.pairing.getByRole("button", { name: "Disconnect" }).click();
  await expect(profileA.pairing.getByRole("status")).toHaveText("Disconnected — Profile B");
  await expect(profileB.pairing.getByRole("status")).toHaveText("Disconnected by Profile A");
  await profileB.pairing.getByRole("button", { name: "Forget the other profile" }).click();
  await expect(profileB.pairing.getByRole("status")).toHaveText("Not paired");
});

test("a profile that disconnects tells the other, whose dashboard says so instead of an error", async ({
  profileA,
  profileB,
}) => {
  await pair(profileA, profileB);
  const dashboard = await dashboardIn(profileB);
  const heading = (state: string) =>
    dashboard.getByRole("heading", { name: `Chrome — Profile A (${state})` });
  await expect(heading("Connected")).toBeVisible();
  await profileA.pairing.getByRole("button", { name: "Disconnect" }).click();
  await expect(heading("Disconnected by Profile A")).toBeVisible();
  await expect(profileB.pairing.getByRole("status")).toHaveText("Disconnected by Profile A");
});
