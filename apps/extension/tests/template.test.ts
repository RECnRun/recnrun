import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { writeStored } from "@/p2p/p2p-database";
import { pocTemplateStore } from "@/storage/poc-template-repository";
import { FINGERPRINT, MASTER, MASTER_KEY, binding, roleRepository, roles } from "./role-fixture";
import { resetStored, storedKeys } from "./memory-p2p-database";

vi.mock("@/p2p/p2p-database", () => import("./memory-p2p-database"));

const PEER = "22222222-2222-4222-8222-222222222222";
const PAIRING = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const pin = {
  fingerprint: FINGERPRINT,
  pinnedAt: 1,
  source: "local-channel",
  identity: MASTER_KEY,
};

/** A profile that worked before: its key and certificate, a pin, and the peer state a base leaves. */
async function workedBefore() {
  await writeStored("certificates", "identity", "key pair");
  await writeStored("certificates", "link", "certificate");
  await fakeBrowser.storage.local.set({
    peerPins: { [PEER]: pin },
    authorizedPeers: { [PEER]: { profileId: PEER, displayName: "Desk" } },
    answeredOffers: { [PEER]: [{ pairingId: PAIRING, expiresAt: 1 }] },
    folderPairing: { paused: [PEER] },
    pocNamespace: "e4-common",
    pocPresencePolicy: "silent",
    profileIdentity: { profileId: MASTER, displayName: "Base" },
  });
  await fakeBrowser.storage.session.set({
    pendingOffers: { [PEER]: { pairingId: PAIRING, expiresAt: 1, to: PEER, code: "x" } },
    peerLinks: { [PEER]: { state: "connected", verified: true } },
    folderActed: { [PEER]: { pairingId: PAIRING, at: 1 } },
    pocNewcomers: { waiting: [PEER], renewed: [] },
    pocBoot: PAIRING,
  });
}

const local = () => fakeBrowser.storage.local.get(null);
const session = () => fakeBrowser.storage.session.get(null);

beforeEach(() => {
  fakeBrowser.reset();
  resetStored();
});

describe("entering template mode", () => {
  test("holds the template role, discards the key and certificate, and clears the peer state", async () => {
    await workedBefore();
    await pocTemplateStore().enter("base-v1");
    expect(await roleRepository.read()).toEqual({ role: "template" });
    expect(await roles().mayAct("announce")).toBe(false);
    expect(storedKeys("certificates")).toEqual([]);
    expect(await local()).toEqual({
      role: { role: "template" },
      pocSetting: "base-v1",
      pocNamespace: "e4-common",
      pocPresencePolicy: "silent",
      profileIdentity: { profileId: MASTER, displayName: "Base" },
    });
    expect(await session()).toEqual({ pocBoot: PAIRING });
  });

  test("is told by the stored role alone, with the setting beside it", async () => {
    const store = pocTemplateStore();
    expect(await store.templateMode()).toBe(false);
    expect(await store.setting()).toBeNull();
    await store.enter("base-v2");
    expect(await store.templateMode()).toBe(true);
    expect(await store.setting()).toBe("base-v2");
    expect(await fakeBrowser.storage.local.get("templateMode")).toEqual({});
    await fakeBrowser.storage.local.set({ templateMode: true });
    await roleRepository.write(null);
    expect(await store.templateMode()).toBe(false);
  });

  test("again is the same template", async () => {
    await pocTemplateStore().enter("base-v1");
    await pocTemplateStore().enter("base-v1");
    expect(await roleRepository.read()).toEqual({ role: "template" });
  });

  test.each([
    ["a bound worker", () => roleRepository.write(binding as never)],
    [
      "the master",
      () => roleRepository.write({ role: "master", profileId: MASTER, identity: MASTER_KEY }),
    ],
  ])("refuses %s and changes nothing", async (_name, assign) => {
    await workedBefore();
    await assign();
    const before = { local: await local(), session: await session() };
    await expect(pocTemplateStore().enter("base-v1")).rejects.toThrow(/never made a template/);
    expect({ local: await local(), session: await session() }).toEqual(before);
    expect(storedKeys("certificates")).toEqual(["identity", "link"]);
  });

  test("refuses a setting outside the pattern before it touches anything", async () => {
    await workedBefore();
    await expect(pocTemplateStore().enter("base-v")).rejects.toThrow();
    expect(await roleRepository.read()).toBeNull();
    expect(storedKeys("certificates")).toEqual(["identity", "link"]);
  });

  test("reads a damaged setting as unset", async () => {
    await fakeBrowser.storage.local.set({ pocSetting: 7 });
    expect(await pocTemplateStore().setting()).toBeNull();
  });
});
