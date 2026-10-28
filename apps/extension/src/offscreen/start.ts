import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { BackgroundReply } from "@/messaging/background-reply";
import { LinkCommandMessageSchema, linkEventMessage } from "@/messaging/peer-messages";
import type { LinkCommand, LinkEvent } from "@/messaging/peer-messages";
import { createFolderWatch } from "@/offscreen/folder-watch";
import type { FolderWatch } from "@/offscreen/folder-watch";
import { certificateFingerprint, persistentCertificate } from "@/p2p/certificate-store";
import { folderAccess, loadFolder } from "@/p2p/folder-store";
import { createPeerLink } from "@/p2p/peer-link";
import type { PeerLink } from "@/p2p/peer-link";

type Send = (message: unknown) => Promise<unknown>;
type Folder = () => Promise<FileSystemDirectoryHandle | undefined>;
type FolderCommand = Extract<LinkCommand, { type: `folder-${string}` }>;

const isFolderCommand = (command: LinkCommand): command is FolderCommand =>
  command.type.startsWith("folder-");

/** The folder's file work, which the background cannot do, since only a window holds the folder. */
async function runFolderCommand(watch: FolderWatch, command: FolderCommand, folder: Folder) {
  switch (command.type) {
    case "folder-status":
      return { access: await folderAccess(await folder()) };
    case "folder-watch":
      return watch.watch(command);
    case "folder-publish":
      return watch.publish(command.signal);
    case "folder-stop":
      return watch.stop();
  }
}

interface Held {
  linkOf: (peer: string) => PeerLink;
  watch: FolderWatch;
}

/** One link per peer, made on first use, each reporting its events under the peer's id. */
function createLinks(certificate: RTCCertificate, report: (event: LinkEvent) => void) {
  const links = new Map<string, PeerLink>();
  return (peer: string): PeerLink => {
    const known = links.get(peer);
    if (known) return known;
    const link: PeerLink = createPeerLink(
      {
        onFrame: (frame) => report({ type: "frame", peer, frame }),
        onState: (state) => {
          const remoteFingerprint = link.remoteFingerprint();
          const fingerprint = remoteFingerprint ? { remoteFingerprint } : {};
          report({ type: "state", peer, state, ...fingerprint });
        },
      },
      { certificate },
    );
    links.set(peer, link);
    return link;
  };
}

/** Runs one command; the offscreen document holds the connections and no logic beyond them. */
async function runLinkCommand(
  { linkOf, watch }: Held,
  command: LinkCommand,
  folder: Folder,
): Promise<unknown> {
  if (isFolderCommand(command)) return runFolderCommand(watch, command, folder);
  const link = linkOf(command.peer);
  switch (command.type) {
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
  }
}

interface OffscreenOptions {
  send?: Send;
  certificate?: () => Promise<RTCCertificate>;
  folder?: Folder;
}

/** Forwards every frame and state change to the background, which decides what they mean. */
export function startOffscreen({
  send = (message) => browser.runtime.sendMessage(message),
  certificate = persistentCertificate,
  folder = loadFolder,
}: OffscreenOptions = {}): void {
  // A sleeping service worker wakes for the message; a closed one makes nothing to report to.
  const report = (event: LinkEvent) => void send(linkEventMessage(event)).catch(() => {});
  const ready = certificate().then((cert) => {
    const fingerprint = certificateFingerprint(cert) ?? "";
    const watch = createFolderWatch({ report, fingerprint, folder });
    return { linkOf: createLinks(cert, report), watch };
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
        .then((held) => runLinkCommand(held, parsed.output.command, folder))
        .then(
          (result) => reply({ ok: true, result }),
          (error: unknown) => reply({ ok: false, error: errorMessage(error) }),
        );
      return true;
    },
  );
}
