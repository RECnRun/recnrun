import type { Transport } from "./transport.ts";

type MessageTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "postMessage" | "location"
>;

/**
 * Exchanges messages between the page and the content script of the same window.
 * Messages from other windows or origins (frames, openers) never reach listeners.
 */
export function createWindowTransport(target: MessageTarget = window): Transport {
  return {
    send(message) {
      target.postMessage(message, target.location.origin);
    },
    subscribe(listener) {
      const receive = (event: MessageEvent) => {
        if (event.source === target && event.origin === target.location.origin) {
          listener(event.data);
        }
      };
      target.addEventListener("message", receive);
      return () => target.removeEventListener("message", receive);
    },
  };
}
