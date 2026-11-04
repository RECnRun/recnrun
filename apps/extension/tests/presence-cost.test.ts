import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPocPresence } from "@/background/downloads-presence";
import {
  authorizedPeersRepository,
  identityRepository,
  peerLinksRepository,
} from "@/storage/peer-repository";
import {
  FINGERPRINT,
  ME,
  PEER,
  PEER_IDENTITY,
  STRANGER,
  answering,
  fakeOffscreen,
} from "./fake-peer";
import { identityOf, signAs } from "./test-identity";

const HALF_TTL = 30_000;
const KEY = "pocPresencePolicy";
// Signed once, so each write waits on microtasks only and the fake timers order every step.
const STATEMENT = await signAs({ profileId: ME, fingerprint: FINGERPRINT });
const sign = async () => STATEMENT;

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(policy: unknown = "linked-silence") {
  const offscreen = fakeOffscreen();
  const download = vi
    .spyOn(fakeBrowser.downloads, "download")
    .mockImplementation(answering(() => 1));
  vi.spyOn(fakeBrowser.downloads, "search").mockImplementation(
    answering(() => [
      {
        id: 1,
        filename: `/tmp/Downloads/RECnRun/poc/lab/peers/${ME}/presence.json`,
        state: "complete",
      },
    ]),
  );
  for (const method of ["addListener", "removeListener"] as const)
    vi.spyOn(fakeBrowser.downloads.onChanged, method).mockImplementation(() => {});
  await identityRepository.write({ profileId: ME, displayName: "Laptop" });
  await fakeBrowser.storage.local.set({ [KEY]: policy });
  await authorizedPeersRepository.set(PEER, {
    profileId: PEER,
    displayName: "Desk",
    fingerprint: FINGERPRINT,
    identity: PEER_IDENTITY,
  });
  await peerLinksRepository.set(PEER, { state: "connected", verified: true });
  const log = vi.fn();
  const presence = startPocPresence({ log, sign, startPairing: async () => {} });
  await vi.advanceTimersByTimeAsync(0);
  return { download, presence, log, offscreen };
}

async function tick() {
  await vi.advanceTimersByTimeAsync(HALF_TTL);
  await fakeBrowser.alarms.onAlarm.trigger({
    name: "poc-presence",
    scheduledTime: Date.now(),
    persistAcrossSessions: true,
  });
  await vi.advanceTimersByTimeAsync(0);
}

test("linked silence writes at boot, stays silent for six alarms, and resumes within a TTL after one link drops", async () => {
  const { download, presence } = await setup();
  for (let count = 0; count < 6; count++) await tick();
  expect(download).toHaveBeenCalledTimes(1);
  await peerLinksRepository.set(PEER, { state: "disconnected", verified: false });
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  await peerLinksRepository.set(PEER, { state: "connected", verified: true });
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  presence.stop();
});

test("one linked peer does not silence a profile missing another link", async () => {
  const { download, presence } = await setup();
  await authorizedPeersRepository.set(STRANGER, {
    profileId: STRANGER,
    displayName: "Third",
    fingerprint: FINGERPRINT,
    identity: await identityOf(STRANGER),
  });
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  presence.stop();
});

test("a restarted worker with a learned root and all links up stays silent", async () => {
  const { download, presence } = await setup();
  presence.stop();
  const restarted = startPocPresence({ log: vi.fn(), sign, startPairing: async () => {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(download).toHaveBeenCalledTimes(1);
  restarted.stop();
});

test("without any authorized peer it keeps announcing", async () => {
  const { download, presence } = await setup();
  await authorizedPeersRepository.set(PEER, null);
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  presence.stop();
});

test.each([null, "baseline"])("%s retains the baseline half-TTL renewal", async (policy) => {
  const { download, presence } = await setup(policy);
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  presence.stop();
});

test("invalid policy and unreadable link state are logged and keep renewal", async () => {
  const { download, presence, log } = await setup("sometimes");
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("presence policy"));
  await fakeBrowser.storage.local.set({ [KEY]: "linked-silence" });
  await fakeBrowser.storage.session.set({ peerLinks: "corrupt" });
  await tick();
  expect(download).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("presence policy"));
  presence.stop();
});

test("a connected but unverified link keeps announcing and an explicit bootstrap still publishes while linked", async () => {
  const { download, presence } = await setup();
  await peerLinksRepository.set(PEER, { state: "connected", verified: false });
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  await peerLinksRepository.set(PEER, { state: "connected", verified: true });
  await presence.publish();
  expect(download).toHaveBeenCalledTimes(3);
  presence.stop();
});

test("heartbeat stays silent while each peer beat within a TTL, also over a dropped link, and renews after a TTL of silence", async () => {
  const { download, presence, offscreen } = await setup("heartbeat");
  let heardAt = Date.now();
  offscreen.link.liveness = () => ({ [PEER]: { heardAt, beats: 1 } });
  for (let count = 0; count < 6; count++) {
    heardAt = Date.now();
    await tick();
  }
  expect(download).toHaveBeenCalledTimes(1);
  heardAt = Date.now();
  await peerLinksRepository.set(PEER, { state: "disconnected", verified: false });
  await tick();
  expect(download).toHaveBeenCalledTimes(1);
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  await tick();
  expect(download).toHaveBeenCalledTimes(3);
  heardAt = Date.now();
  await tick();
  expect(download).toHaveBeenCalledTimes(3);
  presence.stop();
});

test("heartbeat renews for an authorized peer whose link never beat", async () => {
  const { download, presence } = await setup("heartbeat");
  await tick();
  expect(download).toHaveBeenCalledTimes(2);
  presence.stop();
});

test("launcher writes once to learn the root, then leaves renewal to the launcher across a restart", async () => {
  const { download, presence } = await setup("launcher");
  expect(download).toHaveBeenCalledTimes(1);
  for (let count = 0; count < 6; count++) await tick();
  expect(download).toHaveBeenCalledTimes(1);
  presence.stop();
  const restarted = startPocPresence({ log: vi.fn(), sign, startPairing: async () => {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(download).toHaveBeenCalledTimes(1);
  await restarted.publish();
  expect(download).toHaveBeenCalledTimes(2);
  restarted.stop();
});

// Codex P3 finding 2: a silent mesh must still let a newcomer be discovered after every presence expired.
describe.each(["linked-silence", "heartbeat"])("%s and a newcomer", (policy) => {
  async function silent() {
    const started = await setup(policy);
    const beat = () => {
      const heardAt = Date.now();
      const heard = { heardAt, beats: 1 };
      started.offscreen.link.liveness = () => ({ [PEER]: heard, [STRANGER]: heard });
    };
    const quiet = async (count: number) => {
      for (let each = 0; each < count; each++) {
        beat();
        await tick();
      }
    };
    await quiet(6);
    expect(started.download).toHaveBeenCalledTimes(1);
    return { ...started, quiet };
  }

  test("renews once when the catalog shows a profile no record knows, not for linked peers", async () => {
    const { download, presence, quiet } = await silent();
    await presence.noticed([{ profileId: PEER }]);
    await quiet(2);
    expect(download).toHaveBeenCalledTimes(1);
    await presence.noticed([{ profileId: STRANGER }]);
    await quiet(1);
    expect(download).toHaveBeenCalledTimes(2);
    await presence.noticed([{ profileId: STRANGER }]);
    await quiet(3);
    expect(download).toHaveBeenCalledTimes(2);
    presence.stop();
  });

  test("a newcomer that paired before the alarm costs no renewal", async () => {
    const { download, presence, quiet } = await silent();
    await presence.noticed([{ profileId: STRANGER }]);
    await authorizedPeersRepository.set(STRANGER, {
      profileId: STRANGER,
      displayName: "Third",
      fingerprint: FINGERPRINT,
      identity: await identityOf(STRANGER),
    });
    await peerLinksRepository.set(STRANGER, { state: "connected", verified: true });
    await quiet(2);
    expect(download).toHaveBeenCalledTimes(1);
    presence.stop();
  });
});
