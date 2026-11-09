// Types of offer-file.js for the Node tests of the launcher-bridged offer and answer.
import type { Identity } from "./identity.js";

export interface Offer {
  v: 1;
  type: "offer";
  workspace: string;
  root: string;
  attempt: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  sdp: string;
  signature: string;
}

export interface Answer {
  v: 1;
  type: "answer";
  root: string;
  attempt: string;
  nonce: string;
  bootId: string;
  sdp: string;
  workerSpki: string;
  signature: string;
}

export interface OfferContext {
  workspace: string;
  root: string;
  masterKey: JsonWebKey;
}

export declare function isAttempt(value: unknown): boolean;
export declare function offerFileOf(attempt: string): string;
export declare function createOfferCheck(options?: {
  now?: () => number;
}): (offer: unknown, context: OfferContext) => Promise<string | null>;
export declare function signAnswer(input: {
  offer: Offer;
  bootId: string;
  sdp: string;
  identity: Identity;
}): Promise<Answer>;
