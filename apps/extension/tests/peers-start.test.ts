import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPeers } from "@/background/peers";
import { PresenceSchema } from "@/p2p/folder-rendezvous";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  identityRepository,
  peerPinsRepository,
} from "@/storage/peer-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { FINGERPRINT, ME, PEER, PEER_IDENTITY, answering, fakeOffscreen } from "./fake-peer";
import { signAs } from "./test-identity";

const ROOT = "/home/me/Downloads";
const manifest = { manifest_version: 3 as const, name: "RECnRun", version: "0.1.0" };
const RegistrationSchema = v.strictObject({
  ...PresenceSchema.entries,
  namespace: v.string(),
  boot: v.string(),
});

/** chrome.downloads over the fake browser: each write lands under ROOT and completes at once. */
function fakeDownloads() {
  const written: { url: string; filename: string; saveAs: boolean; conflictAction: string }[] = [];
  vi.spyOn(fakeBrowser.downloads, "download").mockImplementation(
    answering((options) => written.push(options as (typeof written)[number])),
  );
  vi.spyOn(fakeBrowser.downloads, "search").mockImplementation(
    answering((query) => {
      const { id = 0 } = query as { id?: number };
      const options = written[id - 1];
      return options ? [{ id, filename: `${ROOT}/${options.filename}`, state: "complete" }] : [];
    }),
  );
  // The fake browser has no downloads.onChanged; every item here has settled already.
  for (const method of ["addListener", "removeListener"] as const)
    vi.spyOn(fakeBrowser.downloads.onChanged, method).mockImplementation(() => {});
  return written;
}

/** The fake browser with this profile's identity, the offscreen document, and Downloads. */
async function background() {
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue(manifest);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  for (const event of ["onMoved", "onAttached"] as const)
    vi.spyOn(fakeBrowser.tabs[event], "addListener").mockImplementation(() => {});
  await identityRepository.write({ profileId: ME, displayName: "Laptop" });
  return { link: fakeOffscreen(), written: fakeDownloads(), log: vi.mocked(console.debug) };
}

const registrationOf = (url: string) => v.parse(RegistrationSchema, JSON.parse(contentOf(url)));

const dashboards = async () =>
  (await fakeBrowser.tabs.query({})).filter((tab) => tab.url?.endsWith("/dashboard.html"));

const contentOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startPeers", () => {
  test("the Downloads variant announces this profile with no folder participation and opens no dashboard", async () => {
    const { written } = await background();
    expect(await folderPairingRepository.read()).toBeNull();

    startPeers({ transport: "downloads", sign: signAs });

    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({
      filename: `RECnRun/poc/lab/peers/${ME}/presence.json`,
      saveAs: false,
      conflictAction: "overwrite",
    });
    const presence = v.parse(RegistrationSchema, JSON.parse(contentOf(written[0]?.url ?? "")));
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
    startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(() =>
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
    const peers = startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(() =>
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
    startPeers({ transport: "downloads", sign: signAs });
    // The resume of a profile that waited before, then the start once the root is known.
    await vi.waitFor(() => expect(link.commands).toHaveLength(2));
    expect(new Set(link.commands.map((each) => each.type))).toEqual(new Set(["folder-watch"]));
    expect(await folderPairingRepository.read()).toEqual({ paused: [PEER] });
  });

  test("the folder variant writes nothing to Downloads and waits in the folder only once chosen", async () => {
    const { link, written } = await background();
    startPeers({ transport: "folder", sign: signAs });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(written).toEqual([]);
    expect(link.commands).toEqual([]);

    await folderPairingRepository.write({});
    startPeers({ transport: "folder", sign: signAs });
    await vi.waitFor(() =>
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
    const routes = startPeers({ transport: "downloads", sign: signAs });
    await routes.link({
      type: "state",
      peer: PEER,
      state: "connected",
      remoteFingerprint: FINGERPRINT,
    });
    expect(await peerPinsRepository.get(PEER)).toMatchObject({
      fingerprint: FINGERPRINT,
      source: "local-channel",
    });
  });
});

describe("the presence startPeers writes", () => {
  test("keeps one boot per browser session, learns the root, and joins the stored namespace", async () => {
    const { written } = await background();
    await fakeBrowser.storage.local.set({ pocNamespace: "e4-common" });
    startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(() => expect(written).toHaveLength(1));
    startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(() => expect(written).toHaveLength(2));

    const [first, again] = written.map((each) => registrationOf(each.url));
    expect(first?.namespace).toBe("e4-common");
    expect(again?.boot).toBe(first?.boot);
    expect(written[1]?.filename).toBe(`RECnRun/poc/e4-common/peers/${ME}/presence.json`);
    await vi.waitFor(async () =>
      expect(await fakeBrowser.storage.session.get("pocDownloadsRoot")).toEqual({
        pocDownloadsRoot: ROOT,
      }),
    );
  });

  test("writes at once, with the boot the bootstrap page stored, when that page asks", async () => {
    const { written } = await background();
    const token = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
    startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(() => expect(written).toHaveLength(1));
    await pocPresenceStore().adoptBoot(token);
    const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/bootstrap.html") };
    const replies: unknown[] = [];
    void fakeBrowser.runtime.onMessage.trigger({ type: "POC_PUBLISH_PRESENCE" }, page, (reply) =>
      replies.push(reply),
    );
    await vi.waitFor(() => expect(replies).toEqual([{ ok: true }]));
    expect(written.map((each) => registrationOf(each.url).boot)).toEqual([
      registrationOf(written[0]?.url ?? "").boot,
      token,
    ]);
  });

  test("writes no presence, and says why, while the offscreen document gives no fingerprint", async () => {
    const { written, log } = await background();
    const replies = [{ ok: false, error: "No certificate." }, "garbage"];
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
      answering(() => replies.shift()),
    );
    startPeers({ transport: "downloads", sign: signAs });
    startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(() => {
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
    const peers = startPeers({ transport: "downloads", sign: signAs });
    await vi.waitFor(async () =>
      expect(await peers.request({ type: "status" })).toMatchObject({
        folder: "none",
        rendezvous: { kind: "downloads", available: true },
      }),
    );
  });
});
