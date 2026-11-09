// Types of file-signal.js for the Node tests of the file-signalled offer.
import type { Identity } from "./identity.js";
import type { LinkState } from "./link-state.js";
import type { OfferContext } from "./offer-file.js";

export declare const POLL_MS: number;

export declare function createFileSignal(input: {
  exchangeUrl: string;
  context: OfferContext;
  deps: {
    readJson: (url: string) => Promise<unknown>;
    check: (offer: unknown, context: OfferContext) => Promise<string | null>;
    link: LinkState;
    connect: (sdp: string, attempt: string) => Promise<string>;
    bootId: () => Promise<string>;
    identity: Promise<Identity>;
    emit: (name: string, body: unknown) => Promise<unknown>;
    log: (text: string) => void;
  };
}): { tick(): Promise<void> };

export declare function readFileJson(url: string): Promise<unknown>;
