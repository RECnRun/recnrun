import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { provenHello } from "@/background/greeting";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import type { Pin } from "@/p2p/pins";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  peerLinksRepository,
  peerPinsRepository,
} from "@/storage/peer-repository";
import { FINGERPRINT, ME, PEER, PEER_HELLO, PEER_IDENTITY, fromPeer } from "./fake-peer";
import { peerBackground } from "./peer-background";
import { identityOf, signAs } from "./test-identity";

const MISMATCH = { state: "failed", verified: false, reason: "certificate" };
const FORGER = await identityOf("forger");
// Lower than ME, so ME answers its offer as soon as the signal is accepted.
const LOW = "00000000-0000-4000-8000-000000000000";
const LOW_KEY = await identityOf(LOW);
const OTHER: Pin = { fingerprint: "EE:EE", pinnedAt: 1, source: "local-channel", identity: FORGER };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pins on a new link", () => {
  test("the first link the handshake proved pins the key that signed its certificate", async () => {
    const { connect } = await peerBackground();
    await connect();
    expect(await peerPinsRepository.get(PEER)).toEqual({
      fingerprint: FINGERPRINT,
      pinnedAt: expect.any(Number),
      source: "pairing-code",
      identity: PEER_IDENTITY,
    });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
  });

  test("a link whose certificate is not the accepted one pins nothing", async () => {
    const { connect } = await peerBackground();
    await connect("00:11:22");
    await connect(null);
    expect(await peerPinsRepository.all()).toEqual({});
  });

  test("closes a link to the accepted certificate when another key is pinned", async () => {
    const { connect, link, log } = await peerBackground();
    await peerPinsRepository.set(PEER, OTHER);
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual(MISMATCH);
    expect(link.commands).toEqual([{ type: "close", peer: PEER }]);
    expect(link.sentTypes()).toEqual([]);
    expect(await peerPinsRepository.get(PEER)).toEqual(OTHER);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a link to the pinned key's certificate is verified and leaves the pin as it was", async () => {
    const { connect } = await peerBackground();
    const pin: Pin = { ...OTHER, fingerprint: FINGERPRINT, identity: PEER_IDENTITY };
    await peerPinsRepository.set(PEER, pin);
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(await peerPinsRepository.get(PEER)).toEqual(pin);
  });

  test("a renewed certificate of the pinned key is verified, and the pin follows it", async () => {
    const { connect } = await peerBackground();
    const pin: Pin = { ...OTHER, identity: PEER_IDENTITY };
    await peerPinsRepository.set(PEER, pin);
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(await peerPinsRepository.get(PEER)).toEqual({ ...pin, fingerprint: FINGERPRINT });
  });
});

describe("the HELLO statement", () => {
  const helloSigned = async (fingerprint: string, as = PEER) => ({
    ...PEER_HELLO,
    identity: await signAs({ profileId: PEER, fingerprint }, as),
  });

  test("a HELLO signed by the accepted key for the proved certificate keeps the link", async () => {
    const { connect, receive, link } = await peerBackground();
    await connect();
    await receive(fromPeer("HELLO", PEER_HELLO));
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(link.commands.filter(({ type }) => type === "close")).toEqual([]);
  });

  test.each([
    ["another key", () => helloSigned(FINGERPRINT, "forger")],
    ["another certificate", () => helloSigned("00:11:22")],
  ])("a HELLO signed for %s closes the link and keeps the pin", async (_, hello) => {
    const { connect, receive, link, log } = await peerBackground();
    await connect();
    const pin = await peerPinsRepository.get(PEER);
    await receive(fromPeer("HELLO", await hello()));
    expect(await peerLinksRepository.get(PEER)).toEqual(MISMATCH);
    expect(link.commands.at(-1)).toEqual({ type: "close", peer: PEER });
    expect(await peerPinsRepository.get(PEER)).toEqual(pin);
    expect(log).toHaveBeenCalledWith(
      "[RECnRun peer]",
      `closed the link to ${PEER}, whose HELLO no valid signature by its identity vouches for`,
    );
  });

  test("a HELLO proves nothing once its peer's authorized record is gone", async () => {
    await peerBackground();
    const hello = fromPeer("HELLO", PEER_HELLO);
    expect(await provenHello(hello)).toBe(true);
    // A Forget between the channel's check and this one drops the record the statement needs.
    await authorizedPeersRepository.set(PEER, null);
    expect(await provenHello(hello)).toBe(false);
  });

  test("this profile's HELLO carries its own statement for its link's certificate", async () => {
    const { connect, link } = await peerBackground();
    await connect();
    const [hello] = link.frames();
    expect(hello).toMatchObject({ type: "HELLO", identity: { key: await identityOf(ME) } });
  });
});

describe("pins on a signal", () => {
  const ANNOUNCED = "0F:0F";
  const offerFrom = async (fingerprint: string, as = LOW, signedFor = fingerprint) =>
    encodePairing({
      kind: "offer",
      pairingId: "44444444-4444-4444-8444-444444444444",
      profileId: LOW,
      displayName: "Low",
      expiresAt: Date.now() + PAIRING_TTL_MS,
      sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`,
      identity: await signAs({ profileId: LOW, fingerprint: signedFor }, as),
    });

  /** A forgotten profile, still pinned, which PEER now lists and relays an offer from. */
  async function relayedOffer(code: string, pinned: Pin | null = { ...OTHER, identity: LOW_KEY }) {
    const background = await peerBackground();
    await folderPairingRepository.write({});
    if (pinned) await peerPinsRepository.set(LOW, pinned);
    await background.connect();
    const member = {
      profileId: LOW,
      displayName: "Low",
      fingerprint: ANNOUNCED,
      identity: LOW_KEY,
    };
    await background.receive(fromPeer("MEMBERS", { members: [member] }));
    await background.receive(fromPeer("SIGNAL", { origin: LOW, target: ME, code }));
    return background;
  }

  const lowCommands = ({ link }: Awaited<ReturnType<typeof relayedOffer>>) =>
    link.commands.filter((command) => "peer" in command && command.peer === LOW);

  test("refuses a signal for a pinned peer that another key signed, before any connection", async () => {
    const background = await relayedOffer(await offerFrom(ANNOUNCED, "forger"));
    await vi.waitFor(() =>
      expect(background.log).toHaveBeenCalledWith(
        "[RECnRun peer]",
        `folder pairing: Refused a code from ${LOW}: its pinned identity did not sign its certificate.`,
      ),
    );
    expect(lowCommands(background)).toEqual([]);
    expect(await peerPinsRepository.get(LOW)).toEqual({ ...OTHER, identity: LOW_KEY });
  });

  test("refuses a signal no valid signature vouches for, even from an unpinned peer", async () => {
    // Its own key's statement, but for another certificate than the one its SDP names.
    const background = await relayedOffer(await offerFrom(ANNOUNCED, LOW, "0E:0E"), null);
    await vi.waitFor(() =>
      expect(background.log).toHaveBeenCalledWith(
        "[RECnRun peer]",
        `folder pairing: Refused a code from ${LOW}: no valid signature names its certificate.`,
      ),
    );
    expect(lowCommands(background)).toEqual([]);
    expect(await peerPinsRepository.get(LOW)).toBeNull();
  });

  test("answers a renewed certificate's signal the pinned key signed", async () => {
    const { link } = await relayedOffer(await offerFrom(ANNOUNCED));
    await vi.waitFor(() =>
      expect(link.commands).toContainEqual(expect.objectContaining({ type: "answer", peer: LOW })),
    );
  });
});
