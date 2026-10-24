import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { askLink, offscreenUrl } from "@/background/offscreen";
import { createPairing } from "@/background/pairing";
import { createPeerChannel } from "@/background/peer-channel";
import type { PeerChannel } from "@/background/peer-channel";
import { handlePeerRequest } from "@/background/peer-requests";
import type { PeerRequestDependencies } from "@/background/peer-requests";
import { executeRemote, sessionStatus, sharedTabs } from "@/background/remote-commands";
import type { ExecutorDependencies } from "@/background/remote-commands";
import { LinkEventSchema, PeerRequestSchema } from "@/messaging/peer-protocol";
import type { Reply } from "@/messaging/peer-protocol";
import type { PeerMessage } from "@/p2p/protocol";
import {
  authorizedPeerRepository,
  identityRepository,
  peerLinkRepository,
  pendingOfferRepository,
  readIdentity,
  remoteControllerRepository,
  remoteRecordingRepository,
} from "@/storage/peer-repository";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

type LinkEvent = v.InferOutput<typeof LinkEventSchema>;

const TAB_EVENTS = [
  "onCreated",
  "onUpdated",
  "onRemoved",
  "onMoved",
  "onAttached",
  "onActivated",
] as const;

/** Test builds keep every frame in memory, so a test can prove what crossed the link. */
const frames: string[] | undefined = import.meta.env.MODE === "test" ? [] : undefined;
if (frames) (globalThis as { recnrunPeerFrames?: string[] }).recnrunPeerFrames = frames;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isOwnPage(sender: Browser.runtime.MessageSender, url = browser.runtime.getURL("/")) {
  return sender.id === browser.runtime.id && sender.url?.startsWith(url) === true;
}

const tell = (message: object) => void browser.runtime.sendMessage(message).catch(() => {});

/** What the controller does with what the executor reports. */
async function mirror(message: PeerMessage): Promise<void> {
  if (message.type === "TABS_CHANGED") {
    const { tabs, currentId } = message;
    tell({
      target: "pages",
      type: "peer-tabs-changed",
      tabs,
      ...(currentId === undefined ? {} : { currentId }),
    });
  }
  if (message.type !== "SESSION_STATUS") return;
  const peer = await authorizedPeerRepository.read();
  if (!peer) return;
  const { session, controlledBy } = message;
  await remoteRecordingRepository.write({
    profileId: message.from,
    displayName: peer.displayName,
    session,
    controlledBy,
    link: "connected",
  });
}

async function onLinkState(
  event: Extract<LinkEvent, { type: "link-state" }>,
  channel: PeerChannel,
) {
  if (event.state !== "connected") {
    await peerLinkRepository.write({ state: event.state, verified: false });
    channel.failAll();
    const copy = await remoteRecordingRepository.read();
    if (copy) await remoteRecordingRepository.write({ ...copy, link: "disconnected" });
    return;
  }
  const peer = await authorizedPeerRepository.read();
  // DTLS proved the peer holds this certificate; only the one the user confirmed is accepted.
  if (!peer || event.remoteFingerprint !== peer.fingerprint) {
    await peerLinkRepository.write({ state: "failed", verified: false });
    await askLink({ type: "link-close" });
    return;
  }
  await peerLinkRepository.write({ state: "connected", verified: true });
  const me = await readIdentity();
  await channel.send("HELLO", {
    displayName: me.displayName,
    extensionVersion: browser.runtime.getManifest().version,
  });
}

function onFrame(frame: string, channel: PeerChannel, executor: ExecutorDependencies) {
  frames?.push(frame);
  return channel.receive(frame).then(async (message) => {
    if (!message) return;
    await executeRemote(message, executor);
    await mirror(message);
  });
}

/** Tells the peer about this profile's tabs and session as they change; nothing polls. */
function watchExecutor(channel: PeerChannel, executor: ExecutorDependencies) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connected = async () => (await peerLinkRepository.read())?.verified === true;
  const tabsChanged = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        if (await connected()) await channel.send("TABS_CHANGED", await sharedTabs());
      })().catch(() => {});
    }, 150);
  };
  for (const event of TAB_EVENTS) browser.tabs[event].addListener(tabsChanged);
  browser.windows.onRemoved.addListener(tabsChanged);
  browser.windows.onFocusChanged.addListener(tabsChanged);
  const sessionChanged = async () => {
    const status = await sessionStatus(executor);
    if (!status.session) await remoteControllerRepository.write(null);
    if (await connected()) await channel.send("SESSION_STATUS", status);
  };
  recordingSessionRepository.watch(() => void sessionChanged().catch(() => {}));
}

function requestDependencies(channel: PeerChannel): PeerRequestDependencies {
  const pairing = createPairing({
    askLink,
    identity: readIdentity,
    authorized: authorizedPeerRepository,
    pending: pendingOfferRepository,
  });
  return {
    channel,
    pairing,
    closeLink: () => askLink({ type: "link-close" }),
    diagnostics: () => askLink({ type: "link-info" }),
    identity: readIdentity,
    rename: (identity) => identityRepository.write(identity),
    authorized: authorizedPeerRepository,
    link: peerLinkRepository,
    mirror: remoteRecordingRepository,
    localSession: recordingSessionRepository,
  };
}

/** The background's half of the cross-profile POC: pairing, routing, and the executor. */
export function startPeers(): void {
  const channel = createPeerChannel({
    askLink,
    identity: readIdentity,
    authorized: authorizedPeerRepository,
    link: peerLinkRepository,
    log: (entry) => console.debug("[RECnRun peer]", entry),
  });
  const executor = {
    channel,
    session: recordingSessionRepository,
    controller: remoteControllerRepository,
  };
  const deps = requestDependencies(channel);
  const offscreen = offscreenUrl();
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: Browser.runtime.MessageSender, reply: (r: Reply) => void) => {
      const event = v.safeParse(LinkEventSchema, message);
      if (event.success && isOwnPage(sender, offscreen)) {
        const done =
          event.output.type === "link-frame"
            ? onFrame(event.output.frame, channel, executor)
            : onLinkState(event.output, channel);
        void done.catch((error: unknown) => console.debug("[RECnRun peer]", errorText(error)));
        return false;
      }
      const request = v.safeParse(PeerRequestSchema, message);
      // Content scripts share the extension id; only extension pages may drive the peer.
      if (!request.success || !isOwnPage(sender)) return false;
      handlePeerRequest(deps, request.output).then(
        (result) => reply({ ok: true, result: result ?? null }),
        (error: unknown) => reply({ ok: false, error: errorText(error) }),
      );
      return true;
    },
  );
  watchExecutor(channel, executor);
}
