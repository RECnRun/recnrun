import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BackgroundReply } from "@/messaging/background-reply";
import { PocFingerprintRequestSchema } from "@/messaging/poc-fingerprint";
import { certificateFingerprint } from "@/p2p/certificate-store";

/**
 * P2.2 (POC PLAN.md): answers the background with the fingerprint of the certificate the links
 * use, so the presence it writes through Downloads announces the same one.
 */
export function startPocFingerprint({
  certificate,
}: {
  certificate: () => Promise<RTCCertificate>;
}) {
  const backgroundUrl = browser.runtime.getURL("/background.js");
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      reply: (answer: BackgroundReply) => void,
    ) => {
      // Only the service worker asks; every page talks to the background instead.
      const fromBackground = sender.id === browser.runtime.id && sender.url === backgroundUrl;
      if (!v.is(PocFingerprintRequestSchema, message) || !fromBackground) return false;
      void certificate()
        .then((cert) => {
          const fingerprint = certificateFingerprint(cert);
          if (!fingerprint) throw new Error("The certificate has no SHA-256 fingerprint.");
          reply({ ok: true, result: { fingerprint } });
        })
        .catch((error: unknown) => reply({ ok: false, error: errorMessage(error) }));
      return true;
    },
  );
}
