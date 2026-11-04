import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { answeredOffers } from "@/storage/answered-repository";
import { PEER } from "./fake-peer";
import { NOW, OFFER_ID, OTHER_ID } from "./folder-sightings";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("the answered offers", () => {
  test("keep every offer answered from one peer", async () => {
    const offers = [
      { pairingId: OFFER_ID, expiresAt: NOW },
      { pairingId: OTHER_ID, expiresAt: NOW + 1 },
    ];
    await answeredOffers().set(PEER, offers);
    expect(await answeredOffers().get(PEER)).toEqual(offers);
  });

  test("drop the single record an older build stored, without failing", async () => {
    await fakeBrowser.storage.local.set({
      answeredOffers: { [PEER]: { pairingId: OFFER_ID, expiresAt: NOW } },
    });
    expect(await answeredOffers().all()).toEqual({ [PEER]: [] });
  });
});
