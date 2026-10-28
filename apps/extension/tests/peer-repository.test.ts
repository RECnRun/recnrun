import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  authorizedPeerRepository,
  identityRepository,
  peerLinkRepository,
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

test("stores, announces, and clears the authorized peer", async () => {
  const changed = vi.fn();
  const unwatch = authorizedPeerRepository.watch(changed);
  expect(await authorizedPeerRepository.read()).toBeNull();
  const peer = {
    profileId: "22222222-2222-4222-8222-222222222222",
    displayName: "Home",
    fingerprint: "AB:CD",
  };
  await authorizedPeerRepository.write(peer);
  expect(await authorizedPeerRepository.read()).toEqual(peer);
  await expect.poll(() => changed.mock.calls.length).toBe(1);
  await authorizedPeerRepository.write(null);
  expect(await authorizedPeerRepository.read()).toBeNull();
  unwatch();
});

test("keeps the link in session storage", async () => {
  await peerLinkRepository.write({ state: "connected", verified: true });
  expect(await fakeBrowser.storage.session.get("peerLink")).toEqual({
    peerLink: { state: "connected", verified: true },
  });
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
