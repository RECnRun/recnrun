import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  identityRepository,
  peerLinksRepository,
  readIdentity,
} from "@/storage/peer-repository";

beforeEach(() => {
  fakeBrowser.reset();
});

test("creates the profile identity once, with a short default name", async () => {
  const [first, second] = await Promise.all([readIdentity(), readIdentity()]);
  expect(second).toEqual(first);
  expect(first.displayName).toBe(`Profile ${first.profileId.slice(0, 4).toUpperCase()}`);
  expect(await identityRepository.read()).toEqual(first);
  expect(await readIdentity()).toEqual(first);
});

test("creates a new identity once the stored one is gone", async () => {
  const first = await readIdentity();
  fakeBrowser.reset();
  const second = await readIdentity();
  expect(second.profileId).not.toBe(first.profileId);
});

const HOME = {
  profileId: "22222222-2222-4222-8222-222222222222",
  displayName: "Home",
  fingerprint: "AB:CD",
};
const WORK = {
  profileId: "33333333-3333-4333-8333-333333333333",
  displayName: "Work",
  fingerprint: "EF:01",
};

test("stores, announces, and clears each authorized peer apart", async () => {
  const changed = vi.fn();
  const unwatch = authorizedPeersRepository.watch(changed);
  expect(await authorizedPeersRepository.all()).toEqual({});
  expect(await authorizedPeersRepository.get(HOME.profileId)).toBeNull();
  // Written at once, as two links coming up do; neither is lost.
  await Promise.all([
    authorizedPeersRepository.set(HOME.profileId, HOME),
    authorizedPeersRepository.set(WORK.profileId, WORK),
  ]);
  expect(await authorizedPeersRepository.all()).toEqual({
    [HOME.profileId]: HOME,
    [WORK.profileId]: WORK,
  });
  await expect.poll(() => changed.mock.calls.length).toBe(2);
  await authorizedPeersRepository.set(HOME.profileId, null);
  expect(await authorizedPeersRepository.all()).toEqual({ [WORK.profileId]: WORK });
  unwatch();
});

test("keeps each peer's link in session storage, and goes on after a failed write", async () => {
  vi.spyOn(fakeBrowser.storage.session, "set").mockRejectedValueOnce(new Error("Quota."));
  const link = { state: "connected" as const, verified: true };
  await expect(peerLinksRepository.set(HOME.profileId, link)).rejects.toThrow("Quota.");
  await peerLinksRepository.set(WORK.profileId, link);
  expect(await fakeBrowser.storage.session.get("peerLinks")).toEqual({
    peerLinks: { [WORK.profileId]: link },
  });
});

test("reads an older build's folder pairing, whose fields it no longer keeps", async () => {
  const acted = { pairingId: "44444444-4444-4444-8444-444444444444", at: 5 };
  await fakeBrowser.storage.local.set({ folderPairing: { acted } });
  expect(await folderPairingRepository.read()).toEqual({});
});

test("rejects a stored value that does not match its schema, and leaves it", async () => {
  await fakeBrowser.storage.local.set({ profileIdentity: { profileId: "not-a-uuid" } });
  await expect(readIdentity()).rejects.toThrow(
    "The stored local:profileIdentity does not match its schema.",
  );
  expect(await fakeBrowser.storage.local.get("profileIdentity")).toEqual({
    profileIdentity: { profileId: "not-a-uuid" },
  });
});
