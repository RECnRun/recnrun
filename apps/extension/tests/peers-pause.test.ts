import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPeers } from "@/background/peers";
import { authorizedPeersRepository } from "@/storage/peer-repository";
import { FINGERPRINT, ME, PEER, PEER_IDENTITY, fromPeer } from "./fake-peer";
import { background, contentOf, registrationOf, settles } from "./peers-start-fixture";
import { quiesce, signing } from "./test-identity";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(async () => {
  await quiesce();
  vi.restoreAllMocks();
});

describe("the pause statement for the launcher", () => {
  const pausedOf = (written: { filename: string; url: string }[]) =>
    written
      .filter((each) => each.filename.endsWith("/paused.json"))
      .map((each) => JSON.parse(contentOf(each.url)) as { reason: string; identity: unknown });

  /** A POC profile with its presence out and PEER authorized, over a link that holds. */
  async function linked() {
    const { written } = await background();
    await authorizedPeersRepository.set(PEER, {
      profileId: PEER,
      displayName: "Desk",
      fingerprint: FINGERPRINT,
      identity: PEER_IDENTITY,
    });
    const routes = startPeers({ transport: "downloads", sign: signing });
    await settles(() => expect(written).toHaveLength(1));
    const connect = () =>
      routes.link({
        type: "state",
        peer: PEER,
        state: "connected",
        remoteFingerprint: FINGERPRINT,
      });
    return { routes, written, connect };
  }

  test("Disconnect writes the statement under the profile's folder, with the presence's identity", async () => {
    const { routes, written } = await linked();
    await routes.request({ type: "disconnect", peer: PEER });
    await settles(() => expect(pausedOf(written)).toHaveLength(1));
    const file = written.find((each) => each.filename.endsWith("/paused.json"));
    expect(file?.filename).toBe(`RECnRun/poc/lab/peers/${ME}/paused.json`);
    expect(Object.keys(JSON.parse(contentOf(file?.url ?? "")))).toEqual([
      "profileId",
      "reason",
      "identity",
      "createdAt",
    ]);
    expect(pausedOf(written)[0]).toMatchObject({
      reason: "disconnect",
      identity: registrationOf(written[0]?.url ?? "").identity,
    });
  });

  test("Forget says forget, and Reconnect says resumed", async () => {
    const { routes, written } = await linked();
    await routes.request({ type: "forget", peer: PEER });
    await routes.request({ type: "pair-again" });
    await settles(() =>
      expect(pausedOf(written).map((each) => each.reason)).toEqual(["forget", "resumed"]),
    );
  });

  test("a BYE from the peer says disconnect, and the link coming back says resumed", async () => {
    const { routes, written, connect } = await linked();
    await connect();
    await settles(() => expect(pausedOf(written).map((each) => each.reason)).toEqual(["resumed"]));
    await routes.link({ type: "frame", peer: PEER, frame: JSON.stringify(fromPeer("BYE", {})) });
    await settles(() =>
      expect(pausedOf(written).map((each) => each.reason)).toEqual(["resumed", "disconnect"]),
    );
    await connect();
    await settles(() =>
      expect(pausedOf(written).map((each) => each.reason)).toEqual([
        "resumed",
        "disconnect",
        "resumed",
      ]),
    );
  });

  test("the folder variant writes no statement", async () => {
    const { written } = await background();
    await authorizedPeersRepository.set(PEER, {
      profileId: PEER,
      displayName: "Desk",
      fingerprint: FINGERPRINT,
      identity: PEER_IDENTITY,
    });
    const routes = startPeers({ transport: "folder", sign: signing });
    await routes.request({ type: "disconnect", peer: PEER });
    expect(written).toEqual([]);
  });
});
