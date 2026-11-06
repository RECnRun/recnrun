import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { ensureOffscreen } from "@/background/link";
import { OFFSCREEN_PAGE } from "@/background/listener";
import { FileReadRequestSchema, readFailure, toReadResult } from "@/p2p/file-url-read";
import type { FileReadRequest, FileReadResult } from "@/p2p/file-url-read";

interface RelayOptions {
  ensure?: () => Promise<void>;
  send?: (request: FileReadRequest) => Promise<unknown>;
}

/**
 * E3 (POC PLAN.md P1.4): relays an extension page's file:// read to the offscreen document,
 * creating it first, since a message sent before it exists reaches no listener there.
 */
export function startPocFileReadRelay({
  ensure = ensureOffscreen,
  send = (request) => browser.runtime.sendMessage(request),
}: RelayOptions = {}): void {
  const extensionUrl = browser.runtime.getURL("/");
  const ownPage = (sender: Browser.runtime.MessageSender) =>
    sender.id === browser.runtime.id &&
    sender.url?.startsWith(extensionUrl) === true &&
    sender.url !== extensionUrl + OFFSCREEN_PAGE;
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      reply: (result: FileReadResult) => void,
    ) => {
      const parsed = v.safeParse(FileReadRequestSchema, message);
      if (!parsed.success || !ownPage(sender)) return false;
      void ensure()
        .then(() => send(parsed.output))
        .then((answer) => toReadResult(answer, "The offscreen document"), readFailure)
        .then(reply);
      return true;
    },
  );
}
