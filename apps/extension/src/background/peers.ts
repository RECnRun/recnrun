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
import type { PeerMessage, PeerPayload, PeerType, SharedTabs } from "@/p2p/protocol";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  identityRepository,
  peerLinksRepository,
  peerTabsRepository,
  pendingOffersRepository,
  readIdentity,
  remoteControllerRepository,
  remoteRecordingsRepository,
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

/** Each peer's tabs as last reported; every change reaches the pages. */
function createTabsCache() {
  return {
    get: (peer: string) => peerTabsRepository.get(peer),
    set: async (peer: string, next: SharedTabs | null) => {
      await peerTabsRepository.set(peer, next);
      notifyPages();
    },
  };
}

type TabsCache = ReturnType<typeof createTabsCache>;

/** What the controller keeps of each executor's reports, under the peer that sent them. */
async function observe(message: PeerMessage, tabs: TabsCache): Promise<void> {
  const { from } = message;
  if (message.type === "TABS_CHANGED" || message.type === "TABS_SNAPSHOT") {
    const { tabs: list, currentId } = message;
    await tabs.set(from, currentId === undefined ? { tabs: list } : { tabs: list, currentId });
  }
  if (message.type === "HELLO") {
    const peer = await authorizedPeersRepository.get(from);
    if (peer && peer.displayName !== message.displayName)
      await authorizedPeersRepository.set(from, { ...peer, displayName: message.displayName });
    await tabs.set(from, null);
  }
  if (message.type === "SESSION_STATUS") {
    const me = await readIdentity();
    const { session, controlledBy } = message;
    const mine = session !== null && controlledBy === me.profileId;
    await remoteRecordingsRepository.set(from, {
      profileId: from,
      session,
      mine,
      connected: true,
    });
    notifyPages();
  }
  if (message.type === "ERROR") log(`peer reported ${message.reason}`);
}

async function hello(channel: PeerChannel, peer: string): Promise<void> {
  const { displayName } = await readIdentity();
  await channel.send(peer, "HELLO", {
    displayName,
    extensionVersion: browser.runtime.getManifest().version,
  });
}

/** The link to `peer` went down; every other peer's link, waiters, and reports stay. */
async function linkDown(peer: string, state: LinkState, channel: PeerChannel) {
  // The reason for an intended close or a refused certificate outlives the states that follow.
  const reason = (await peerLinksRepository.get(peer).catch(() => null))?.reason;
  await peerLinksRepository.set(peer, { state, verified: false, ...(reason && { reason }) });
  channel.failPeer(peer);
  // The last report stays, marked unknown: only the executor may say a session ended.
  const mirror = await remoteRecordingsRepository.get(peer).catch(() => null);
  if (mirror) await remoteRecordingsRepository.set(peer, { ...mirror, connected: false });
  notifyPages();
}

type StateEvent = Extract<LinkEvent, { type: "state" }>;

async function linkUp(event: StateEvent, channel: PeerChannel, folder: FolderPairingFlow) {
  const authorized = await authorizedPeersRepository.get(event.peer);
  // DTLS proved the other side holds this certificate; only the one the user accepted may talk.
  if (!authorized || event.remoteFingerprint !== authorized.fingerprint) {
    log("closed a link whose certificate is not the accepted one");
    const refused = { state: "failed", verified: false, reason: "certificate" } as const;
    await peerLinksRepository.set(event.peer, refused);
    await askLink({ type: "close", peer: event.peer });
    return;
  }
  await peerLinksRepository.set(event.peer, { state: "connected", verified: true });
  await folder.linked();
  await hello(channel, event.peer);
  notifyPages();
}

/** The peer said it closes the link on purpose, so this side closes too, without waiting for ICE. */
async function closedByPeer(channel: PeerChannel, peer: string) {
  await peerLinksRepository.set(peer, {
    state: "disconnected",
    verified: false,
    reason: "closed-by-peer",
  });
  await linkDown(peer, "disconnected", channel);
  await askLink({ type: "close", peer });
}

function createLinkHandler(
  channel: PeerChannel,
  executor: ExecutorDependencies,
  tabs: TabsCache,
  folder: FolderPairingFlow,
) {
  const onFrame = async (frame: string, peer: string) => {
    tap?.push(frame);
    const received = await channel.receive(frame, peer);
    if (received.kind !== "accepted") {
      log(`dropped an ${received.kind} frame`);
      // Only a verified peer learns why; anything else gets no answer.
      if (received.kind === "invalid")
        await channel.send(peer, "ERROR", { reason: "Invalid message." }).catch(() => {});
      return;
    }
    if (received.message.type === "BYE") return closedByPeer(channel, received.message.from);
    await execute(received.message, executor);
    await observe(received.message, tabs);
  };
  const handle = async (event: LinkEvent) => {
    if (event.type === "frame") return onFrame(event.frame, event.peer);
    if (event.type === "folder") return folder.seen(event);
    if (event.state === "connected") return linkUp(event, channel, folder);
    if (event.state !== "connecting") return linkDown(event.peer, event.state, channel);
    await peerLinksRepository.set(event.peer, { state: "connecting", verified: false });
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

/** The peers whose link is verified now. */
async function linkedPeers(): Promise<string[]> {
  const links = await peerLinksRepository.all().catch(() => ({}));
  return Object.entries(links).flatMap(([peer, link]) => (link.verified ? [peer] : []));
}

/** Sends one report to every linked peer; one that cannot get it leaves the others theirs. */
async function report<T extends PeerType>(channel: PeerChannel, type: T, payload: PeerPayload<T>) {
  const send = (peer: string) =>
    channel.send(peer, type, payload).catch((error: unknown) => log(errorMessage(error)));
  await Promise.all((await linkedPeers()).map(send));
}

/** Tells every linked peer about this profile's tabs and session as they change; nothing polls. */
function watchExecutor(channel: PeerChannel, executor: ExecutorDependencies) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tabsChanged = () => {
    clearTimeout(timer);
    // One report per burst of events, as the dashboard reads once per burst.
    timer = setTimeout(() => {
      void (async () => {
        await report(channel, "TABS_CHANGED", await sharedTabs(executor.tabs));
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
    await report(channel, "SESSION_STATUS", status);
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
    hello: (peer) => hello(channel, peer),
    askLink,
    identity: readIdentity,
    rename: (identity) => identityRepository.write(identity),
    authorized: authorizedPeersRepository,
    link: peerLinksRepository,
    mirror: remoteRecordingsRepository,
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
    authorized: authorizedPeersRepository,
    pending: pendingOffersRepository,
  });
  return createFolderPairing({
    askLink,
    identity: readIdentity,
    pairing,
    authorized: authorizedPeersRepository,
    pending: pendingOffersRepository,
    link: peerLinksRepository,
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
    authorized: authorizedPeersRepository,
    link: peerLinksRepository,
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
