import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { LinkCommandSchema } from "@/messaging/peer-protocol";
import type { LinkCommand, Reply } from "@/messaging/peer-protocol";
import { certificateFingerprint, persistentCertificate } from "@/p2p/certificate-store";
import { createPeerLink } from "@/p2p/peer-link";
import type { PeerLink } from "@/p2p/peer-link";

type Send = (message: unknown) => Promise<unknown>;

/** Runs one link command; the offscreen document holds no logic beyond the connection. */
export async function runLinkCommand(
  link: PeerLink,
  command: LinkCommand,
  certificate: RTCCertificate,
): Promise<unknown> {
  switch (command.type) {
    case "link-fingerprint":
      return { fingerprint: certificateFingerprint(certificate) };
    case "link-offer":
      return { sdp: await link.createOffer() };
    case "link-answer":
      return { sdp: await link.acceptOffer(command.sdp) };
    case "link-accept-answer":
      return link.acceptAnswer(command.sdp);
    case "link-send":
      return { sent: link.send(command.frame) };
    case "link-close":
      return link.close();
    case "link-info":
      return {
        state: link.state(),
        remoteFingerprint: link.remoteFingerprint(),
        diagnostics: link.diagnostics(),
      };
  }
}

/** Forwards every frame and state change to the background, which decides what they mean. */
export function startOffscreen(send: Send = (message) => browser.runtime.sendMessage(message)) {
  const report = (message: object) =>
    void send({ target: "background", ...message }).catch(() => {});
  const certificate = persistentCertificate();
  let link: PeerLink | undefined;
  const linkFor = async (): Promise<[PeerLink, RTCCertificate]> => {
    const cert = await certificate;
    link ??= createPeerLink(
      {
        onFrame: (frame) => report({ type: "link-frame", frame }),
        onState: (state) =>
          report({ type: "link-state", state, remoteFingerprint: link?.remoteFingerprint() }),
      },
      { certificate: cert },
    );
    return [link, cert];
  };
  const backgroundUrl = browser.runtime.getURL("/background.js");
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: Browser.runtime.MessageSender, reply: (r: Reply) => void) => {
      const command = v.safeParse(LinkCommandSchema, message);
      // Only the service worker commands the link; pages talk to the background instead.
      if (!command.success || sender.id !== browser.runtime.id || sender.url !== backgroundUrl) {
        return false;
      }
      linkFor()
        .then(([current, cert]) => runLinkCommand(current, command.output, cert))
        .then(
          (result) => reply({ ok: true, result: result ?? null }),
          (error: unknown) =>
            reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
      return true;
    },
  );
}
