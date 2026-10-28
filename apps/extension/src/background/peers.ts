import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { execute, sessionStatus, sharedTabs } from "@/background/executor";
import type { ExecutorDependencies } from "@/background/executor";
import { createFolderPairing } from "@/background/folder-pairing";
import type { FolderPairingFlow } from "@/background/folder-pairing";
import { askLink, closeOffscreen } from "@/background/link";
import { createMeshPairing } from "@/background/mesh-pairing";
import type { MeshPairingFlow } from "@/background/mesh-pairing";
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
  folderActedRepository,
  folderPairingRepository,
  identityRepository,
  meshMembersRepository,
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

/** Pairing through the RECnRun folder, and through the peers linked already. */
interface PairingFlows {
  folder: FolderPairingFlow;
  mesh: MeshPairingFlow;
}

/** The link to `peer` went down; every other peer's link, waiters, and reports stay. */
async function linkDown(
  peer: string,
  state: LinkState,
  channel: PeerChannel,
  mesh: MeshPairingFlow,
) {
  // The reason for an intended close or a refused certificate outlives the states that follow.
  const reason = (await peerLinksRepository.get(peer).catch(() => null))?.reason;
  await peerLinksRepository.set(peer, { state, verified: false, ...(reason && { reason }) });
  channel.failPeer(peer);
  // The last report stays, marked unknown: only the executor may say a session ended.
  const mirror = await remoteRecordingsRepository.get(peer).catch(() => null);
  if (mirror) await remoteRecordingsRepository.set(peer, { ...mirror, connected: false });
  await mesh.dropped(peer);
  notifyPages();
}

type StateEvent = Extract<LinkEvent, { type: "state" }>;

async function linkUp(event: StateEvent, channel: PeerChannel, flows: PairingFlows) {
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
  await flows.folder.linked(event.peer);
  await hello(channel, event.peer);
  await flows.mesh.announce();
  notifyPages();
}

/** The peer said it closes the link on purpose, so this side closes too, without waiting for ICE. */
async function closedByPeer(channel: PeerChannel, peer: string, mesh: MeshPairingFlow) {
  await peerLinksRepository.set(peer, {
    state: "disconnected",
    verified: false,
    reason: "closed-by-peer",
  });
  await linkDown(peer, "disconnected", channel, mesh);
  await askLink({ type: "close", peer });
}

function createLinkHandler(
  channel: PeerChannel,
  executor: ExecutorDependencies,
  tabs: TabsCache,
  flows: PairingFlows,
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
    const { message } = received;
    if (message.type === "BYE") return closedByPeer(channel, message.from, flows.mesh);
    await execute(message, executor);
    await observe(message, tabs);
    await flows.mesh.receive(message);
  };
  const handle = async (event: LinkEvent) => {
    if (event.type === "frame") return onFrame(event.frame, event.peer);
    if (event.type === "folder") return flows.folder.seen(event);
    if (event.state === "connected") return linkUp(event, channel, flows);
    if (event.state !== "connecting") return linkDown(event.peer, event.state, channel, flows.mesh);
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
  { folder, mesh }: PairingFlows,
): PeerRequestDependencies {
  // Reconnect also asks the peers linked already, which need no folder.
  const viaMesh = () => mesh.look("all");
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
      paused: folder.paused,
      start: () => folder.start().then(notifyPages),
      pause: folder.pause,
      unpause: (peer) => folder.unpause(peer).then(viaMesh).then(notifyPages),
      unpauseAll: () => folder.unpauseAll().then(viaMesh).then(notifyPages),
      release: closeOffscreen,
    },
  };
}

/** Pairing through the folder and through the mesh, which exchange the same offer and answer codes. */
function createPairingFlows(channel: PeerChannel): PairingFlows {
  const pairing = createPairing({
    askLink,
    identity: readIdentity,
    authorized: authorizedPeersRepository,
    pending: pendingOffersRepository,
  });
  const folder = createFolderPairing({
    askLink,
    identity: readIdentity,
    pairing,
    pending: pendingOffersRepository,
    link: peerLinksRepository,
    acted: folderActedRepository,
    state: folderPairingRepository,
    log,
  });
  const mesh = createMeshPairing({
    channel,
    identity: readIdentity,
    pairing,
    authorized: authorizedPeersRepository,
    link: peerLinksRepository,
    pending: pendingOffersRepository,
    acted: folderActedRepository,
    members: meshMembersRepository,
    state: folderPairingRepository,
    exclusive: folder.exclusive,
    log,
  });
  return { folder, mesh };
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
  const flows = createPairingFlows(channel);
  const { folder } = flows;
  // Chrome starts the worker with the browser only for a startup listener; starting resumes.
  browser.runtime.onStartup.addListener(() => {});
  void folder.resume().catch((error: unknown) => log(errorMessage(error)));
  // Chrome ends the folder's grant with the last extension page, so the pages read it again.
  browser.tabs.onRemoved.addListener(notifyPages);
  const deps = requestDependencies(channel, tabs, flows);
  return {
    request: (request) => handlePeerRequest(deps, request),
    link: createLinkHandler(channel, executor, tabs, flows),
  };
}
