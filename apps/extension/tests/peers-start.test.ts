import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPeers } from "@/background/peers";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  peerPinsRepository,
} from "@/storage/peer-repository";
import { roleStores } from "@/storage/hierarchy-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { FINGERPRINT, ME, PEER, PEER_IDENTITY, STRANGER, answering } from "./fake-peer";
import { ROOT, background, registrationOf, settles } from "./peers-start-fixture";
import { quiesce, signAs, signing } from "./test-identity";

const dashboards = async () =>
  (await fakeBrowser.tabs.query({})).filter((tab) => tab.url?.endsWith("/dashboard.html"));

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(async () => {
  await quiesce();
  vi.restoreAllMocks();
});

describe("startPeers", () => {
  test("the Downloads variant announces this profile with no folder participation and opens no dashboard", async () => {
    const { written } = await background();
    expect(await folderPairingRepository.read()).toBeNull();

    startPeers({ transport: "downloads", sign: signing });

    await settles(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({
      filename: `RECnRun/poc/lab/peers/${ME}/presence.json`,
      saveAs: false,
      conflictAction: "overwrite",
    });
    const presence = registrationOf(written[0]?.url ?? "");
    expect(presence).toMatchObject({
      profileId: ME,
      displayName: "Laptop",
      fingerprint: FINGERPRINT,
    });
    expect(presence.namespace).toBe("lab");
    expect(await dashboards()).toEqual([]);
  });

  test("the Downloads variant starts pairing on its own once it learned its root, with no page open", async () => {
    const { link } = await background();
    startPeers({ transport: "downloads", sign: signing });
    await settles(() =>
      expect(link.commands).toEqual([
        { type: "folder-watch", profileId: ME, displayName: "Laptop" },
      ]),
    );
    expect(await fakeBrowser.storage.session.get("pocDownloadsRoot")).toEqual({
      pocDownloadsRoot: ROOT,
    });
    expect(await folderPairingRepository.read()).toEqual({});
    expect(await dashboards()).toEqual([]);
  });

  test("the Downloads variant starts no pairing while Chrome has not told it the root", async () => {
    const { link, written, log } = await background();
    // Chrome renamed the write, so its path does not tell the root.
    const renamed = `${ROOT}/RECnRun/poc/lab/peers/${ME}/presence (1).json`;
    vi.mocked(fakeBrowser.downloads.search).mockImplementation(
      answering(() => [{ id: 1, filename: renamed, state: "complete" }]),
    );
    const peers = startPeers({ transport: "downloads", sign: signing });
    await settles(() =>
      expect(log).toHaveBeenCalledWith(
        "[RECnRun peer]",
        `presence: Chrome wrote "${renamed}", not RECnRun/poc/lab/peers/${ME}/presence.json`,
      ),
    );
    expect(written).toHaveLength(1);
    expect(link.commands).toEqual([]);
    expect(await folderPairingRepository.read()).toBeNull();
    expect(await peers.request({ type: "status" })).toMatchObject({
      rendezvous: { kind: "downloads", available: false },
    });
  });

  test("the Downloads variant keeps the profiles the user disconnected when it starts pairing", async () => {
    const { link } = await background();
    await folderPairingRepository.write({ paused: [PEER] });
    startPeers({ transport: "downloads", sign: signing });
    // The resume of a profile that waited before, then the start once the root is known.
    await settles(() => expect(link.commands).toHaveLength(2));
    expect(new Set(link.commands.map((each) => each.type))).toEqual(new Set(["folder-watch"]));
    expect(await folderPairingRepository.read()).toEqual({ paused: [PEER] });
  });

  test("the folder variant writes nothing to Downloads and waits in the folder only once chosen", async () => {
    const { link, written } = await background();
    startPeers({ transport: "folder", sign: signing });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toEqual([]);
    expect(link.commands).toEqual([]);

    await folderPairingRepository.write({});
    startPeers({ transport: "folder", sign: signing });
    await settles(() =>
      expect(link.commands).toEqual([
        { type: "folder-watch", profileId: ME, displayName: "Laptop" },
      ]),
    );
    expect(written).toEqual([]);
    expect(await dashboards()).toEqual([]);
  });

  test("the Downloads variant pins a peer met through the local channel once the handshake proved it", async () => {
    await background();
    const desk = {
      profileId: PEER,
      displayName: "Desk",
      fingerprint: FINGERPRINT,
      identity: PEER_IDENTITY,
    };
    await authorizedPeersRepository.set(PEER, desk);
    const routes = startPeers({ transport: "downloads", sign: signing });
    await routes.link({
      type: "state",
      peer: PEER,
      state: "connected",
      remoteFingerprint: FINGERPRINT,
    });
    expect(await peerPinsRepository().get(PEER)).toMatchObject({
      fingerprint: FINGERPRINT,
      source: "local-channel",
    });
  });
});

describe("the presence startPeers writes", () => {
  test("keeps one boot per browser session, learns the root, and joins the stored namespace", async () => {
    const { written } = await background();
    await fakeBrowser.storage.local.set({ pocNamespace: "e4-common" });
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(1));
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(2));

    const [first, again] = written.map((each) => registrationOf(each.url));
    expect(first?.namespace).toBe("e4-common");
    expect(again?.boot).toBe(first?.boot);
    expect(written[1]?.filename).toBe(`RECnRun/poc/e4-common/peers/${ME}/presence.json`);
    await settles(async () =>
      expect(await fakeBrowser.storage.session.get("pocDownloadsRoot")).toEqual({
        pocDownloadsRoot: ROOT,
      }),
    );
  });

  test("writes at once, with the boot the bootstrap page stored, when that page asks", async () => {
    const { written } = await background();
    const token = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(1));
    await pocPresenceStore().adoptBoot(token);
    const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/bootstrap.html") };
    const replies: unknown[] = [];
    void fakeBrowser.runtime.onMessage.trigger({ type: "POC_PUBLISH_PRESENCE" }, page, (reply) =>
      replies.push(reply),
    );
    await settles(() => expect(replies).toEqual([{ ok: true }]));
    expect(written.map((each) => registrationOf(each.url).boot)).toEqual([
      registrationOf(written[0]?.url ?? "").boot,
      token,
    ]);
  });

  test("acknowledges the launcher's attempt with the presence's identity and the session's boot", async () => {
    const { written } = await background();
    const token = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(1));
    await pocPresenceStore().adoptBoot(token);
    const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/bootstrap.html") };
    const replies: unknown[] = [];
    void fakeBrowser.runtime.onMessage.trigger({ type: "POC_PUBLISH_PRESENCE" }, page, (reply) =>
      replies.push(reply),
    );
    await settles(() => expect(replies).toHaveLength(1));
    void fakeBrowser.runtime.onMessage.trigger({ type: "POC_LAUNCHER_ACK", token }, page, (reply) =>
      replies.push(reply),
    );
    await settles(() => expect(replies).toEqual([{ ok: true }, { ok: true }]));
    const ack = written.at(-1);
    expect(ack?.filename).toMatch(new RegExp(`/acks/${ME}/${token}\\.json$`));
    const body = JSON.parse(decodeURIComponent((ack?.url ?? "").split(",")[1] ?? ""));
    const presence = registrationOf(written.at(-2)?.url ?? "");
    expect(Object.keys(body)).toEqual(["token", "profileId", "identity", "boot", "createdAt"]);
    expect(body).toMatchObject({ token, profileId: ME, boot: token, identity: presence.identity });
  });

  test("writes no presence, and says why, while the offscreen document gives no fingerprint", async () => {
    const { written, log } = await background();
    const replies = [{ ok: false, error: "No certificate." }, "garbage"];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
      answering(() => replies.shift()),
    );
    startPeers({ transport: "downloads", sign: signing });
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => {
      expect(log).toHaveBeenCalledWith("[RECnRun peer]", "presence: No certificate.");
      expect(log).toHaveBeenCalledWith(
        "[RECnRun peer]",
        "presence: The offscreen document did not answer.",
      );
    });
    expect(written).toEqual([]);
  });
});

describe("the transport a page sees", () => {
  test("the Downloads variant tells its pages it pairs through Downloads once Chrome reported the root", async () => {
    await background();
    const peers = startPeers({ transport: "downloads", sign: signing });
    await settles(async () =>
      expect(await peers.request({ type: "status" })).toMatchObject({
        folder: "none",
        rendezvous: { kind: "downloads", available: true },
      }),
    );
  });
});

describe("a stored template", () => {
  const silent = "role template: no announcement, discovery, or pairing";

  test("announces nothing, watches no folder, and starts no pairing through the real startup", async () => {
    const { link, written, log } = await background();
    await roleStores().role.write({ role: "template" });
    await folderPairingRepository.write({});
    const peers = startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(log).toHaveBeenCalledWith("[RECnRun peer]", silent));
    const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/bootstrap.html") };
    const replies: unknown[] = [];
    void fakeBrowser.runtime.onMessage.trigger({ type: "POC_PUBLISH_PRESENCE" }, page, (reply) =>
      replies.push(reply),
    );
    await peers.request({ type: "folder-pair" });
    await peers.request({ type: "pair-again" });
    await peers.request({ type: "reconnect", peer: PEER });
    expect(written).toEqual([]);
    expect(link.commands).toEqual([]);
    expect(replies).toEqual([]);
    expect(await peers.request({ type: "status" })).toMatchObject({
      rendezvous: { kind: "downloads", available: false },
    });
  });

  test("a profile without a stored role still announces", async () => {
    const { written } = await background();
    expect(await roleStores().role.read()).toBeNull();
    startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(1));
  });

  test("a catalog sighting notes a profile no record knows for one renewal", async () => {
    await background();
    const routes = startPeers({ transport: "downloads", sign: signing });
    const stranger = {
      profileId: STRANGER,
      displayName: "Desk",
      fingerprint: FINGERPRINT,
      identity: await signAs({ profileId: STRANGER, fingerprint: FINGERPRINT }),
      createdAt: 0,
      expiresAt: Date.now() + 60_000,
    };
    await routes.link({ type: "folder", presences: [stranger], signals: [] });
    expect(await pocPresenceStore().newcomers.read()).toEqual({ waiting: [STRANGER], renewed: [] });
  });
});
