import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocLivenessRequestSchema } from "@/messaging/poc-liveness";
import type { LinkLiveness } from "@/messaging/poc-liveness";

/**
 * P3.6 (POC PLAN.md): answers the background with when each DataChannel last heard its peer and
 * how many beats it sent, so a POC presence policy can leave liveness to the heartbeat.
 */
export function startPocLiveness(liveness: () => Promise<Record<string, LinkLiveness>>): void {
  const backgroundUrl = browser.runtime.getURL("/background.js");
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      reply: (answer: BackgroundReply) => void,
    ) => {
      // Only the service worker asks; every page talks to the background instead.
      const fromBackground = sender.id === browser.runtime.id && sender.url === backgroundUrl;
      if (!v.is(PocLivenessRequestSchema, message) || !fromBackground) return false;
      liveness().then(
        (peers) => reply({ ok: true, result: { peers } }),
        (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
      );
      return true;
    },
  );
}
