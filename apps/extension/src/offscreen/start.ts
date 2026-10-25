import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BackgroundReply } from "@/messaging/background-reply";
import { LinkCommandMessageSchema, linkEventMessage } from "@/messaging/peer-messages";
import type { LinkCommand, LinkEvent } from "@/messaging/peer-messages";
import { certificateFingerprint, persistentCertificate } from "@/p2p/certificate-store";
import { createPeerLink } from "@/p2p/peer-link";
import type { PeerLink } from "@/p2p/peer-link";

type Send = (message: unknown) => Promise<unknown>;

/** Runs one command; the offscreen document holds the connection and no logic beyond it. */
async function runLinkCommand(
  link: PeerLink,
  command: LinkCommand,
  certificate: RTCCertificate,
): Promise<unknown> {
  switch (command.type) {
    case "fingerprint":
      return { fingerprint: certificateFingerprint(certificate) };
    case "offer":
      return { sdp: await link.createOffer() };
    case "answer":
      return { sdp: await link.acceptOffer(command.sdp) };
    case "accept-answer":
      return link.acceptAnswer(command.sdp);
    case "send":
      return { sent: link.send(command.frame) };
    case "close":
      return link.close();
    case "info":
      return { state: link.state(), diagnostics: link.diagnostics() };
  }
}

interface OffscreenOptions {
  send?: Send;
  certificate?: () => Promise<RTCCertificate>;
}

/** Forwards every frame and state change to the background, which decides what they mean. */
export function startOffscreen({
  send = (message) => browser.runtime.sendMessage(message),
  certificate = persistentCertificate,
}: OffscreenOptions = {}): void {
  // A sleeping service worker wakes for the message; a closed one makes nothing to report to.
  const report = (event: LinkEvent) => void send(linkEventMessage(event)).catch(() => {});
  const ready = certificate().then((cert) => {
    const link: PeerLink = createPeerLink(
      {
        onFrame: (frame) => report({ type: "frame", frame }),
        onState: (state) => {
          const remoteFingerprint = link.remoteFingerprint();
          report({ type: "state", state, ...(remoteFingerprint ? { remoteFingerprint } : {}) });
        },
      },
      { certificate: cert },
    );
    return { link, cert };
  });
  const backgroundUrl = browser.runtime.getURL("/background.js");
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      reply: (r: BackgroundReply) => void,
    ) => {
      const parsed = v.safeParse(LinkCommandMessageSchema, message);
      // Only the service worker commands the link; every page talks to the background instead.
      if (!parsed.success || sender.id !== browser.runtime.id || sender.url !== backgroundUrl) {
        return false;
      }
      ready
        .then(({ link, cert }) => runLinkCommand(link, parsed.output.command, cert))
        .then(
          (result) => reply({ ok: true, result }),
          (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
        );
      return true;
    },
  );
}
