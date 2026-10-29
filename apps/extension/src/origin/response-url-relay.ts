import * as v from "valibot";
import { browser } from "wxt/browser";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import {
  PORT_OFFER_EVENT,
  RELAY_READY_EVENT,
  ResponseUrlPairsSchema,
} from "@/messaging/response-url-protocol";
import type { ResponseUrlPairs } from "@/messaging/response-url-protocol";

/**
 * Takes the page script's port at document_start: the first offer is the page script's, since no
 * page script runs before both, and the listener is gone once it is taken.
 */
export function acceptPort(target: EventTarget, onPort: (port: MessagePort) => void): void {
  const take = (event: Event) => {
    const [port] = event instanceof MessageEvent ? event.ports : [];
    if (port === undefined) return;
    event.preventDefault();
    target.removeEventListener(PORT_OFFER_EVENT, take);
    onPort(port);
  };
  target.addEventListener(PORT_OFFER_EVENT, take);
  // A page script that ran first offers its port again on this; none listens otherwise.
  target.dispatchEvent(new Event(RELAY_READY_EVENT));
}

/** Sends the page script the URLs the background answers for this frame, or none. */
export async function relayUrls(port: MessagePort, ask: () => Promise<unknown>): Promise<void> {
  let pairs: ResponseUrlPairs = [];
  try {
    const reply = v.parse(BackgroundReplySchema, await ask());
    if (reply.ok) pairs = v.parse(ResponseUrlPairsSchema, reply.result);
  } catch {
    // The page reads every response natively then, as without RECnRun.
  }
  port.postMessage(pairs);
}

export function startResponseUrlRelay(): void {
  // Only Incognito pages are restored, so a normal window's page reads every response natively.
  if (!browser.extension.inIncognitoContext) {
    acceptPort(document, (port) => port.postMessage([]));
    return;
  }
  const ask = () => browser.runtime.sendMessage({ type: "response-urls" });
  acceptPort(document, (port) => void relayUrls(port, ask));
}
