import * as v from "valibot";
import { peerRecords } from "@/storage/peer-repository";
import type { PeerRecords } from "@/storage/peer-repository";

/** The last offer this profile answered from one peer, kept until that offer expires. */
const AnsweredOfferSchema = v.strictObject({
  pairingId: v.pipe(v.string(), v.uuid()),
  expiresAt: v.number(),
});

export type AnsweredOffer = v.InferOutput<typeof AnsweredOfferSchema>;

let store: PeerRecords<AnsweredOffer> | undefined;

/**
 * Local, so a relaunched browser leaves alone an offer still on disk that it answered already.
 * Made on first call: an item made at load would stay in the production background.
 */
export const answeredOffers = () =>
  (store ??= peerRecords("local:answeredOffers", AnsweredOfferSchema));
