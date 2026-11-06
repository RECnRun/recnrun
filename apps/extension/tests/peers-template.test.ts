import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPeers } from "@/background/peers";
import { writeStored } from "@/p2p/p2p-database";
import { roleStores } from "@/storage/hierarchy-repository";
import { identityRepository } from "@/storage/peer-repository";
import { clearTransientPeerState } from "@/storage/poc-template-repository";
import { pocTransportStore } from "@/storage/poc-transport-repository";
import { ME } from "./fake-peer";
import { resetStored, storedKeys } from "./memory-p2p-database";
import { background, contentOf, registrationOf, settles } from "./peers-start-fixture";
import { MASTER, MASTER_KEY } from "./role-fixture";
import { quiesce, signing } from "./test-identity";

vi.mock("@/p2p/p2p-database", () => import("./memory-p2p-database"));

const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const INSTANCE = "44444444-4444-4444-8444-444444444444";
const OPERATION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const silent = "role template: no announcement, discovery, or pairing";
const provision = {
  type: "POC_PROVISION_CLONE",
  token: TOKEN,
  instanceId: INSTANCE,
  operationId: OPERATION,
  namespace: "clones",
  masterProfileId: MASTER,
  masterIdentity: MASTER_KEY,
};

/** Sends `message` as the extension's bootstrap page does, and collects the replies. */
function fromBootstrap(message: unknown, replies: unknown[], hash = "") {
  const url = fakeBrowser.runtime.getURL("/bootstrap.html") + hash;
  const page = { id: fakeBrowser.runtime.id, url };
  void fakeBrowser.runtime.onMessage.trigger(message, page, (reply) => replies.push(reply));
}

const CLONE_HASH = `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=clones&master=${MASTER}.${MASTER_KEY}`;

const bodyOf = (url = "") => JSON.parse(contentOf(url)) as Record<string, unknown>;

beforeEach(() => {
  fakeBrowser.reset();
  resetStored();
});

afterEach(async () => {
  await quiesce();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a stored template's worker", () => {
  test("answers the template ack, with no identity, while it announces nothing", async () => {
    const { written, log } = await background();
    await roleStores().role.write({ role: "template" });
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(log).toHaveBeenCalledWith("[RECnRun peer]", silent));
    const replies: unknown[] = [];
    fromBootstrap(
      { type: "POC_LAUNCHER_ACK", token: TOKEN, template: true, setting: "base-v1" },
      replies,
    );
    await settles(() => expect(replies).toEqual([{ ok: true }]));
    expect(written.map((each) => each.filename)).toEqual([
      `RECnRun/poc/lab/acks/${ME}/${TOKEN}.json`,
    ]);
    expect(Object.keys(bodyOf(written[0]?.url))).toEqual([
      "token",
      "profileId",
      "boot",
      "createdAt",
      "template",
      "setting",
    ]);
  });

  test("is provisioned by the clone bootstrap: ack first, then a presence as the instance", async () => {
    const { written, log } = await background();
    await roleStores().role.write({ role: "template" });
    await writeStored("certificates", "identity", "the base's key");
    await writeStored("certificates", "link", "the base's certificate");
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(log).toHaveBeenCalledWith("[RECnRun peer]", silent));
    const replies: unknown[] = [];
    fromBootstrap(provision, replies, CLONE_HASH);
    await settles(() => expect(replies).toEqual([{ ok: true }]));
    await settles(() => expect(written).toHaveLength(2));
    const [ack, presence] = written;
    expect(ack?.filename).toBe(`RECnRun/poc/clones/acks/${INSTANCE}/${TOKEN}.json`);
    expect(bodyOf(ack?.url)).toMatchObject({
      token: TOKEN,
      profileId: INSTANCE,
      boot: TOKEN,
      instanceId: INSTANCE,
      operationId: OPERATION,
      provisioned: true,
    });
    expect(presence?.filename).toBe(`RECnRun/poc/clones/peers/${INSTANCE}/presence.json`);
    const registration = registrationOf(presence?.url ?? "");
    expect(registration).toMatchObject({ profileId: INSTANCE, boot: TOKEN });
    expect(registration.identity.key).toBe((bodyOf(ack?.url).identity as { key: string }).key);
    expect(storedKeys("certificates")).toEqual([]);
    expect(await identityRepository.read()).toEqual({
      profileId: INSTANCE,
      displayName: "Profile 4444",
    });
    expect(await roleStores().role.read()).toMatchObject({ role: "worker", source: "bootstrap" });
  });
});

describe("a worker that becomes a template while it runs", () => {
  test("publishes no more presences, on the alarm or on the bootstrap page's request", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    const { written } = await background();
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(1));
    const alarm = () => {
      vi.setSystemTime(Date.now() + 60_000);
      return fakeBrowser.alarms.onAlarm.trigger({
        name: "poc-presence",
        scheduledTime: Date.now(),
        persistAcrossSessions: true,
      });
    };
    await alarm();
    await settles(() => expect(written).toHaveLength(2));
    await roleStores().role.write({ role: "template" });
    await alarm();
    const replies: unknown[] = [];
    fromBootstrap({ type: "POC_PUBLISH_PRESENCE" }, replies);
    await settles(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(2);
  });
});

test("clearing the transient peer state also drops the recorded transport error", async () => {
  await pocTransportStore().recordError("The role template announces nothing.");
  await clearTransientPeerState();
  expect(await pocTransportStore().lastError()).toBeNull();
});

test("clearing the transient peer state also drops the template's stored pause", async () => {
  await pocTransportStore().setPaused("disconnect");
  await clearTransientPeerState();
  expect(await pocTransportStore().paused()).toBeNull();
  expect((await fakeBrowser.storage.local.get("pocPaused")).pocPaused).toBeUndefined();
});
