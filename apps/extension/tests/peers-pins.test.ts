import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import type { Pin } from "@/p2p/pins";
import {
  folderPairingRepository,
  peerLinksRepository,
  peerPinsRepository,
} from "@/storage/peer-repository";
import { FINGERPRINT, ME, PEER, fromPeer } from "./fake-peer";
import { peerBackground } from "./peer-background";

const MISMATCH = { state: "failed", verified: false, reason: "certificate" };
const OTHER: Pin = { fingerprint: "EE:EE", pinnedAt: 1, source: "local-channel" };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pins on a new link", () => {
  test("the first link the handshake proved pins its certificate", async () => {
    const { connect } = await peerBackground();
    await connect();
    expect(await peerPinsRepository.get(PEER)).toEqual({
      fingerprint: FINGERPRINT,
      pinnedAt: expect.any(Number),
      source: "pairing-code",
    });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
  });

  test("a link whose certificate is not the accepted one pins nothing", async () => {
    const { connect } = await peerBackground();
    await connect("00:11:22");
    await connect(null);
    expect(await peerPinsRepository.all()).toEqual({});
  });

  test("closes a link to the accepted certificate when another one is pinned", async () => {
    const { connect, link, log } = await peerBackground();
    await peerPinsRepository.set(PEER, OTHER);
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual(MISMATCH);
    expect(link.commands).toEqual([{ type: "close", peer: PEER }]);
    expect(link.sentTypes()).toEqual([]);
    expect(await peerPinsRepository.get(PEER)).toEqual(OTHER);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a link to the pinned certificate is verified and leaves the pin as it was", async () => {
    const { connect } = await peerBackground();
    const pin: Pin = { ...OTHER, fingerprint: FINGERPRINT };
    await peerPinsRepository.set(PEER, pin);
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(await peerPinsRepository.get(PEER)).toEqual(pin);
  });
});

describe("pins on a signal", () => {
  // Lower than ME, so ME answers its offer as soon as the signal is accepted.
  const LOW = "00000000-0000-4000-8000-000000000000";
  const ANNOUNCED = "0F:0F";
  const offerFrom = (fingerprint: string) =>
    encodePairing({
      kind: "offer",
      pairingId: "44444444-4444-4444-8444-444444444444",
      profileId: LOW,
      displayName: "Low",
      expiresAt: Date.now() + PAIRING_TTL_MS,
      sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`,
    });

  /** A forgotten profile, still pinned, which PEER now lists and relays an offer from. */
  async function relayedOffer(pinned: string) {
    const background = await peerBackground();
    await folderPairingRepository.write({});
    await peerPinsRepository.set(LOW, { ...OTHER, fingerprint: pinned });
    await background.connect();
    const members = [{ profileId: LOW, displayName: "Low", fingerprint: ANNOUNCED }];
    await background.receive(fromPeer("MEMBERS", { members }));
    const code = offerFrom(ANNOUNCED);
    await background.receive(fromPeer("SIGNAL", { origin: LOW, target: ME, code }));
    return background;
  }

  test("refuses a signal announcing another certificate for a pinned peer before any connection", async () => {
    const { link, log } = await relayedOffer(OTHER.fingerprint);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "[RECnRun peer]",
        `folder pairing: Refused a code from ${LOW}: its certificate is not the one pinned.`,
      ),
    );
    expect(link.commands.filter((command) => "peer" in command && command.peer === LOW)).toEqual(
      [],
    );
    expect(await peerPinsRepository.get(LOW)).toEqual(OTHER);
  });

  test("answers the same signal when the pinned certificate is the announced one", async () => {
    const { link } = await relayedOffer(ANNOUNCED);
    await vi.waitFor(() =>
      expect(link.commands).toContainEqual(expect.objectContaining({ type: "answer", peer: LOW })),
    );
  });
});
