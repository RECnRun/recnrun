import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { execute, sessionStatus, sharedTabs } from "@/background/executor";
import type { ExecutorDependencies } from "@/background/executor";
import { createFolderPairing } from "@/background/folder-pairing";
import type { FolderPairingFlow } from "@/background/folder-pairing";
import { askLink, closeOffscreen } from "@/background/link";
import { createPairing } from "@/background/pairing";
import { createPeerChannel } from "@/background/peer-channel";
import type { PeerChannel } from "@/background/peer-channel";
import { handlePeerRequest } from "@/background/peer-requests";
import type { PeerRequestDependencies } from "@/background/peer-requests";
import type { PeerRoutes } from "@/background/routes";
import { peerNotice } from "@/messaging/peer-messages";
import type { LinkCommand, LinkEvent, LinkState } from "@/messaging/peer-messages";
import { FolderAccessSchema } from "@/messaging/peer-results";
import type { PeerMessage, SharedTabs } from "@/p2p/protocol";
import {
  authorizedPeerRepository,
  folderPairingRepository,
  identityRepository,
  peerLinkRepository,
  peerTabsRepository,
  pendingOfferRepository,
  readIdentity,
  remoteControllerRepository,
  remoteRecordingRepository,
} from "@/storage/peer-repository";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { browserTabs } from "@/tabs/open-tabs";

const log = (entry: string) => console.debug("[RECnRun peer]", entry);
const notifyPages = () => void browser.runtime.sendMessage(peerNotice()).catch(() => {});

/** Test builds keep every frame both ways, so a test can prove what crossed the link. */
const tap: string[] | undefined = import.meta.env.MODE === "test" ? [] : undefined;
if (tap) Object.assign(globalThis, { recnrunPeerFrames: tap });

function tappedAskLink(command: LinkCommand): Promise<unknown> {
  if (command.type === "send") tap?.push(command.frame);
  return askLink(command);
}

/** The peer's tabs as last reported; every change reaches the pages. */
function createTabsCache() {
  return {
    read: () => peerTabsRepository.read(),
    write: async (next: SharedTabs | null) => {
      await peerTabsRepository.write(next);
      notifyPages();
    },
  };
}

type TabsCache = ReturnType<typeof createTabsCache>;

/** What the controller keeps of the executor's reports. */
async function observe(message: PeerMessage, tabs: TabsCache): Promise<void> {
  if (message.type === "TABS_CHANGED" || message.type === "TABS_SNAPSHOT") {
    const { tabs: list, currentId } = message;
    await tabs.write(currentId === undefined ? { tabs: list } : { tabs: list, currentId });
  }
  if (message.type === "HELLO") {
    const peer = await authorizedPeerRepository.read();
    if (peer && peer.displayName !== message.displayName)
      await authorizedPeerRepository.write({ ...peer, displayName: message.displayName });
    await tabs.write(null);
  }
  if (message.type === "SESSION_STATUS") {
    const me = await readIdentity();
    const { session, controlledBy } = message;
    const mine = session !== null && controlledBy === me.profileId;
    await remoteRecordingRepository.write({
      profileId: message.from,
      session,
      mine,
      connected: true,
    });
    notifyPages();
  }
  if (message.type === "ERROR") log(`peer reported ${message.reason}`);
}

async function hello(channel: PeerChannel): Promise<void> {
  const { displayName } = await readIdentity();
  await channel.send("HELLO", {
    displayName,
    extensionVersion: browser.runtime.getManifest().version,
  });
}

async function linkDown(state: LinkState, channel: PeerChannel) {
  // The reason for an intended close or a refused certificate outlives the states that follow.
  const reason = (await peerLinkRepository.read().catch(() => null))?.reason;
  await peerLinkRepository.write({ state, verified: false, ...(reason && { reason }) });
  channel.failAll();
  // The last report stays, marked unknown: only the executor may say a session ended.
  const mirror = await remoteRecordingRepository.read().catch(() => null);
  if (mirror) await remoteRecordingRepository.write({ ...mirror, connected: false });
  notifyPages();
}

type StateEvent = Extract<LinkEvent, { type: "state" }>;

async function linkUp(event: StateEvent, channel: PeerChannel, folder: FolderPairingFlow) {
  const peer = await authorizedPeerRepository.read();
  // DTLS proved the other side holds this certificate; only the one the user accepted may talk.
  if (!peer || event.remoteFingerprint !== peer.fingerprint) {
    log("closed a link whose certificate is not the accepted one");
    await peerLinkRepository.write({ state: "failed", verified: false, reason: "certificate" });
    await askLink({ type: "close", peer: event.peer });
    return;
  }
  await peerLinkRepository.write({ state: "connected", verified: true });
  await folder.linked();
  await hello(channel);
  notifyPages();
}

/** The peer said it closes the link on purpose, so this side closes too, without waiting for ICE. */
async function closedByPeer(channel: PeerChannel, peer: string) {
  await peerLinkRepository.write({
    state: "disconnected",
    verified: false,
    reason: "closed-by-peer",
  });
  await linkDown("disconnected", channel);
  await askLink({ type: "close", peer });
}

function createLinkHandler(
  channel: PeerChannel,
  executor: ExecutorDependencies,
  tabs: TabsCache,
  folder: FolderPairingFlow,
) {
  const onFrame = async (frame: string) => {
    tap?.push(frame);
    const received = await channel.receive(frame);
    if (received.kind !== "accepted") {
      log(`dropped an ${received.kind} frame`);
      // Only the verified peer learns why; anything else gets no answer.
      if (received.kind === "invalid")
        await channel.send("ERROR", { reason: "Invalid message." }).catch(() => {});
      return;
    }
    if (received.message.type === "BYE") return closedByPeer(channel, received.message.from);
    await execute(received.message, executor);
    await observe(received.message, tabs);
  };
  const handle = async (event: LinkEvent) => {
    if (event.type === "frame") return onFrame(event.frame);
    if (event.type === "folder") return folder.seen(event);
    if (event.state === "connected") return linkUp(event, channel, folder);
    if (event.state !== "connecting") return linkDown(event.state, channel);
    await peerLinkRepository.write({ state: "connecting", verified: false });
    notifyPages();
  };
  let queue = Promise.resolve();
  // In arrival order, so a frame sent before the channel closed is read while the link is verified.
  return (event: LinkEvent) => {
    const next = queue.then(() => handle(event));
    queue = next.catch(() => {});
    return next;
  };
}

const TAB_EVENTS = [
  "onCreated",
  "onUpdated",
  "onRemoved",
  "onMoved",
  "onAttached",
  "onActivated",
] as const;

/** Tells the peer about this profile's tabs and session as they change; nothing polls. */
function watchExecutor(channel: PeerChannel, executor: ExecutorDependencies) {
  const linked = async () => (await peerLinkRepository.read().catch(() => null))?.verified === true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tabsChanged = () => {
    clearTimeout(timer);
    // One report per burst of events, as the dashboard reads once per burst.
    timer = setTimeout(() => {
      void (async () => {
        if (await linked()) await channel.send("TABS_CHANGED", await sharedTabs(executor.tabs));
      })().catch((error: unknown) => log(errorMessage(error)));
    }, 150);
  };
  for (const event of TAB_EVENTS) browser.tabs[event].addListener(tabsChanged);
  browser.windows.onRemoved.addListener(tabsChanged);
  browser.windows.onFocusChanged.addListener(tabsChanged);
  const sessionChanged = async () => {
    const status = await sessionStatus(executor);
    if (!status.session) await remoteControllerRepository.write(null);
    notifyPages();
    if (await linked()) await channel.send("SESSION_STATUS", status);
  };
  recordingSessionRepository.watch(() => void sessionChanged().catch(() => {}));
}

const FolderStatusSchema = v.object({ access: FolderAccessSchema });

function requestDependencies(
  channel: PeerChannel,
  tabs: TabsCache,
  folder: FolderPairingFlow,
): PeerRequestDependencies {
  return {
    channel,
    hello: () => hello(channel),
    askLink,
    identity: readIdentity,
    rename: (identity) => identityRepository.write(identity),
    authorized: authorizedPeerRepository,
    link: peerLinkRepository,
    mirror: remoteRecordingRepository,
    localSession: recordingSessionRepository,
    controller: remoteControllerRepository,
    tabs,
    folder: {
      access: async () =>
        v.parse(FolderStatusSchema, await askLink({ type: "folder-status" })).access,
      waiting: async () => (await folderPairingRepository.read()) !== null,
      start: () => folder.start().then(notifyPages),
      stop: folder.stop,
      release: closeOffscreen,
    },
  };
}

/** Pairing through the folder, which exchanges the offer and answer codes. */
function createFolder(): FolderPairingFlow {
  const pairing = createPairing({
    askLink,
    identity: readIdentity,
    authorized: authorizedPeerRepository,
    pending: pendingOfferRepository,
  });
  return createFolderPairing({
    askLink,
    identity: readIdentity,
    pairing,
    authorized: authorizedPeerRepository,
    pending: pendingOfferRepository,
    link: peerLinkRepository,
    state: folderPairingRepository,
    log,
  });
}

/**
 * The background's half of the cross-profile POC: pairing, the authorized channel, the executor
 * of the peer's commands, and the controller's copy of what the peer reports.
 */
export function startPeers(): PeerRoutes {
  const channel = createPeerChannel({
    askLink: tappedAskLink,
    identity: readIdentity,
    authorized: authorizedPeerRepository,
    link: peerLinkRepository,
    log,
  });
  const executor: ExecutorDependencies = {
    channel,
    session: recordingSessionRepository,
    controller: remoteControllerRepository,
    tabs: browserTabs().read,
  };
  const tabs = createTabsCache();
  watchExecutor(channel, executor);
  const folder = createFolder();
  // Chrome starts the worker with the browser only for a startup listener; starting resumes.
  browser.runtime.onStartup.addListener(() => {});
  void folder.resume().catch((error: unknown) => log(errorMessage(error)));
  // Chrome ends the folder's grant with the last extension page, so the pages read it again.
  browser.tabs.onRemoved.addListener(notifyPages);
  const deps = requestDependencies(channel, tabs, folder);
  return {
    request: (request) => handlePeerRequest(deps, request),
    link: createLinkHandler(channel, executor, tabs, folder),
  };
}
