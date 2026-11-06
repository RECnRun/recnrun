import { setTimeout as delay } from "node:timers/promises";
import { readSignal, signalFile, virtualPeer } from "../experiments/fixtures/e5-virtual.ts";
import { signalWrites } from "../experiments/fixtures/e5-observe.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { linkedPeers, storedIn } from "./fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "./fixtures/downloads-profiles.ts";
import { forgeRegistry } from "./fixtures/forger.ts";
import { backgroundLog, pinOf, presenceOf, withPair, within } from "./fixtures/trust.ts";
import type { Pair } from "./fixtures/trust.ts";

/*
 * POC PLAN.md P3.3 on Google Chrome Stable: a forger who writes files as the same OS user claims a
 * pinned profile's id while that profile is closed. It writes a presence, registry.json, an offer,
 * and an answer with a certificate and an identity key of its own, then replays the real profile's
 * statement over a connection whose certificate that statement does not name. The other profile
 * makes it no offer, refuses its codes before any connection, never completes a handshake with it,
 * and keeps the pin; the real profile links again when it returns.
 */

const REFUSED_MS = 90_000;
const RELINK_MS = 120_000;

test.describe.configure({ timeout: 480_000 });

/** A forger's virtual peer claiming `claimed`'s id, its certificate in a blank tab of `host`. */
const forgerOf = async (pair: Pair, host: DownloadsProfile, claimed: DownloadsProfile) =>
  virtualPeer(await host.context.newPage(), pair.group.downloads, claimed.profileId);

/** The next offer `from` writes for `to` with another pairing than `before`. */
function nextOffer(pair: Pair, from: DownloadsProfile, to: DownloadsProfile, before?: string) {
  const path = signalFile(pair.group.downloads, from.profileId, "offer", to.profileId);
  return within(async () => {
    const offer = await readSignal(path);
    return offer && offer.pairingId !== before ? offer : undefined;
  }, RELINK_MS);
}

/** The first line of `log` that contains `text`, waiting for it. */
const logged = (log: string[], text: string) =>
  within(async () => log.find((line) => line.includes(text)), REFUSED_MS);

/** What `profile` stores for `peer` under `key`. */
async function recordOf(profile: DownloadsProfile, key: string, peer: DownloadsProfile) {
  const [area, name] = key.split(":") as ["local" | "session", string];
  const records = (await storedIn(profile.serviceWorker, area, name)) as
    | Record<string, unknown>
    | undefined;
  return records?.[peer.profileId];
}

/** The states `profile` gave its link with `peer` from now until `done` settles. */
async function linkStatesUntil(
  profile: DownloadsProfile,
  peer: DownloadsProfile,
  done: Promise<unknown>,
) {
  const states = new Set<string>();
  const watch = { settled: false };
  void done.finally(() => (watch.settled = true));
  while (!watch.settled) {
    const link = (await recordOf(profile, "session:peerLinks", peer)) as
      | { state?: string }
      | undefined;
    states.add(link?.state ?? "none");
    await delay(100);
  }
  return [...states];
}

/** The real `absent` profile starts again: `observer` links with it under the pin it held. */
async function realReturns(pair: Pair, observer: DownloadsProfile, absent: DownloadsProfile) {
  const pinned = await pinOf(observer, absent);
  await pair.group.relaunch(absent);
  pair.group.startCatalog();
  const pin = await within(
    async () =>
      (await linkedPeers(observer)).includes(absent.profileId)
        ? pinOf(observer, absent)
        : undefined,
    RELINK_MS,
  );
  expect(pin).toEqual(pinned);
}

test("a forged presence and catalog that claim a pinned profile get no offer", () =>
  withPair("recnrun-forged-presence", async (pair) => {
    const { group, offerer, answerer } = pair;
    const pinned = await pinOf(offerer, answerer);
    const log = backgroundLog(offerer.context);
    await pair.stopCatalog();
    await group.quit(answerer);
    const since = Date.now();
    const forger = await forgerOf(pair, offerer, answerer);
    await forger.announce();
    const stopRegistry = await forgeRegistry(group, forger);

    const refusal = `no offer to ${answerer.profileId}: its certificate is signed by another identity than the one pinned`;
    expect(await logged(log, refusal), log.join("\n")).toBeDefined();
    const offers = (await signalWrites(offerer)).filter(
      (each) => each.name === `offer-${answerer.profileId}.json` && each.startedAt >= since,
    );
    expect(offers).toEqual([]);
    expect(await pinOf(offerer, answerer)).toEqual(pinned);

    forger.stop();
    stopRegistry();
    await realReturns(pair, offerer, answerer);
  }));

test("a forged answer to a pending offer is refused before any connection", () =>
  withPair("recnrun-forged-answer", async (pair) => {
    const { group, offerer, answerer } = pair;
    const pinned = await pinOf(offerer, answerer);
    const real = await presenceOf(group, answerer);
    const offerPath = signalFile(group.downloads, offerer.profileId, "offer", answerer.profileId);
    const before = (await readSignal(offerPath))?.pairingId;
    const log = backgroundLog(offerer.context);
    await group.quit(answerer);
    const forger = await forgerOf(pair, offerer, answerer);
    // A copy of the real presence draws an offer; then the forger names its own certificate.
    await forger.announce({ fingerprint: real.fingerprint, identity: real.identity });
    const offer = await nextOffer(pair, offerer, answerer, before);
    if (!offer) throw new Error("The offerer made no offer to the copied presence.");
    await pair.stopCatalog();
    await forger.announce();
    const stopRegistry = await forgeRegistry(group, forger);
    const authorized = await recordOf(offerer, "local:authorizedPeers", answerer);
    const answer = await forger.signal("answer", offerer.profileId, { answering: offer });
    await forger.write("answer", offerer.profileId, JSON.stringify(answer));

    const refusal = `Refused a code from ${answerer.profileId}: its pinned identity did not sign its certificate.`;
    expect(await logged(log, refusal), log.join("\n")).toBeDefined();
    // Refused before it was applied: the offer still waits, and the forger's certificate is not accepted.
    const pending = await recordOf(offerer, "session:pendingOffers", answerer);
    expect(pending).toMatchObject({ pairingId: offer.pairingId });
    expect(await recordOf(offerer, "local:authorizedPeers", answerer)).toEqual(authorized);
    expect(await pinOf(offerer, answerer)).toEqual(pinned);

    forger.stop();
    stopRegistry();
    await realReturns(pair, offerer, answerer);
  }));

test("a forged offer that claims a pinned profile gets no answer", () =>
  withPair("recnrun-forged-offer", async (pair) => {
    const { group, offerer, answerer } = pair;
    const pinned = await pinOf(answerer, offerer);
    const log = backgroundLog(answerer.context);
    await pair.stopCatalog();
    await group.quit(offerer);
    const forger = await forgerOf(pair, answerer, offerer);
    await forger.announce();
    const stopRegistry = await forgeRegistry(group, forger);
    const authorized = await recordOf(answerer, "local:authorizedPeers", offerer);
    const offer = await forger.signal("offer", answerer.profileId);
    const refusal = `Refused a code from ${offerer.profileId}: its pinned identity did not sign its certificate.`;
    const refused = logged(log, refusal);
    // The answerer makes a connection only for an offer it accepted.
    const states = linkStatesUntil(answerer, offerer, refused);
    await forger.write("offer", answerer.profileId, JSON.stringify(offer));

    expect(await refused, log.join("\n")).toBeDefined();
    expect(await states).not.toContain("connecting");
    expect(await recordOf(answerer, "local:authorizedPeers", offerer)).toEqual(authorized);
    const answers = (await signalWrites(answerer)).filter(
      (each) => each.pairingId === offer.pairingId,
    );
    expect(answers).toEqual([]);
    expect(await pinOf(answerer, offerer)).toEqual(pinned);

    forger.stop();
    stopRegistry();
    await realReturns(pair, answerer, offerer);
  }));

test("a replayed statement over another certificate never completes a handshake", () =>
  withPair("recnrun-forged-replay", async (pair) => {
    const { group, offerer, answerer } = pair;
    const pinned = await pinOf(offerer, answerer);
    const real = await presenceOf(group, answerer);
    const offerPath = signalFile(group.downloads, offerer.profileId, "offer", answerer.profileId);
    const before = (await readSignal(offerPath))?.pairingId;
    await group.quit(answerer);
    const forger = await forgerOf(pair, offerer, answerer);
    const claim = { fingerprint: real.fingerprint, identity: real.identity };
    await forger.announce(claim);
    const offer = await nextOffer(pair, offerer, answerer, before);
    if (!offer) throw new Error("The offerer made no offer to the replayed presence.");
    // The SDP names the real certificate; the connection behind it holds the forger's.
    const answer = await forger.signal("answer", offerer.profileId, {
      answering: offer,
      claim,
      hold: true,
    });
    const failed = within(async () => {
      const seen = await forger.linkStates();
      return seen.includes("peer:failed") ? seen : undefined;
    }, REFUSED_MS);
    const offererStates = linkStatesUntil(offerer, answerer, failed);
    await forger.write("answer", offerer.profileId, JSON.stringify(answer));

    // ICE reached the forger; the offerer refused its certificate, so the forger's link failed.
    const states = await failed;
    expect(states, (await forger.linkStates()).join(", ")).toContain("ice:connected");
    expect(await offererStates).not.toContain("connected");
    expect(await linkedPeers(offerer)).toEqual([]);
    expect(await pinOf(offerer, answerer)).toEqual(pinned);

    forger.stop();
    await realReturns(pair, offerer, answerer);
  }));
