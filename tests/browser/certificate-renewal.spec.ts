import { expect, test } from "./fixtures/chrome.ts";
import { linkedPeers } from "./fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "./fixtures/downloads-profiles.ts";
import {
  backgroundLog,
  pinOf,
  presenceOf,
  renewAndRestart,
  withPair,
  within,
} from "./fixtures/trust.ts";
import type { Pair } from "./fixtures/trust.ts";

/*
 * POC PLAN.md P3.3 on Google Chrome Stable: two poc-d0 roots pair over Downloads. One renews its
 * DTLS certificate through the POC diagnostics hook and restarts, as an expiry would; its peer
 * follows the renewal by the identity key it pinned, online or offline at the time, with no
 * gesture. A renewal that also discards the identity key leaves a certificate no pinned key
 * signed, and the peer refuses it.
 */

const LINK_MS = 60_000;
const RELINK_MS = 120_000;
const REFUSED_MS = 90_000;

interface Renewal {
  group: Pair["group"];
  /** Profile A renews; Profile B is its peer. */
  renewing: DownloadsProfile;
  peer: DownloadsProfile;
}

/** Runs `body` on a linked pair whose Profile A renews. */
const withRenewal = (body: (renewal: Renewal) => Promise<void>) =>
  withPair("recnrun-renewal", ({ group, profiles: [renewing, peer] }) =>
    body({ group, renewing, peer }),
  );

test.describe.configure({ timeout: 480_000 });

/** Waits until `peer` is linked with `renewing` again under a pin naming `fingerprint`. */
const relinkedOn = ({ renewing, peer }: Renewal, fingerprint: string) =>
  within(async () => {
    const pin = await pinOf(peer, renewing);
    const linked = (await linkedPeers(peer)).includes(renewing.profileId);
    return linked && pin?.fingerprint === fingerprint ? pin : undefined;
  }, RELINK_MS);

test("a renewed certificate relinks with no gesture under the same pinned key, online or offline", () =>
  withRenewal(async (pair) => {
    const { group, renewing, peer } = pair;
    const pinned = await pinOf(peer, renewing);
    if (!pinned) throw new Error("The first link pinned nothing.");

    const online = await renewAndRestart(group, renewing);
    expect(online).not.toBe(pinned.fingerprint);
    expect(await relinkedOn(pair, online)).toEqual({ ...pinned, fingerprint: online });
    expect(await linkedPeers(renewing)).toEqual([peer.profileId]);

    // The peer is closed while the certificate changes, so it meets the new one only when it starts.
    await group.quit(peer);
    const offline = await renewAndRestart(group, renewing);
    expect(
      await within(
        async () => (await presenceOf(group, renewing)).fingerprint === offline || undefined,
        LINK_MS,
      ),
    ).toBe(true);
    await group.relaunch(peer);
    expect(await relinkedOn(pair, offline)).toEqual({ ...pinned, fingerprint: offline });
  }));

test("a renewed certificate that the pinned key did not sign is refused, and the pin stays", () =>
  withRenewal(async ({ group, renewing, peer }) => {
    const pinned = await pinOf(peer, renewing);
    if (!pinned) throw new Error("The first link pinned nothing.");
    const log = backgroundLog(peer.context);

    const discarded = await renewAndRestart(group, renewing, true);
    const announced = await within(async () => {
      const presence = await presenceOf(group, renewing);
      return presence.fingerprint === discarded ? presence : undefined;
    }, LINK_MS);
    expect(announced?.identity.key).toBeDefined();
    expect(announced?.identity.key).not.toBe(pinned.identity);

    // One side offers by profile id order: the peer either makes no offer or refuses the code.
    const refusal = new RegExp(
      `no offer to ${renewing.profileId}: its certificate is signed by another identity|` +
        `Refused a code from ${renewing.profileId}: its pinned identity did not sign`,
    );
    const refused = await within(async () => log.find((line) => refusal.test(line)), REFUSED_MS);
    expect(refused, log.join("\n")).toBeDefined();
    expect(await linkedPeers(peer)).toEqual([]);
    expect(await pinOf(peer, renewing)).toEqual(pinned);
  }));
