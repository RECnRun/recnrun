import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { FileReadRequestSchema, readFileUrl } from "@/p2p/file-url-read";
import type { FileReadResult, WebApis } from "@/p2p/file-url-read";

/**
 * E3 (POC PLAN.md P1.4): reads a file:// URL in the offscreen document for the background, which
 * relays a page's request here, so a page can compare its own read with this context's.
 */
export function startPocFileRead({ apis = globalThis as WebApis }: { apis?: WebApis } = {}): void {
  const backgroundUrl = browser.runtime.getURL("/background.js");
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      reply: (result: FileReadResult) => void,
    ) => {
      const parsed = v.safeParse(FileReadRequestSchema, message);
      // Only the service worker asks; a page's own request reaches the background instead.
      if (!parsed.success || sender.id !== browser.runtime.id || sender.url !== backgroundUrl) {
        return false;
      }
      void readFileUrl(parsed.output, apis).then(reply);
      return true;
    },
  );
}
