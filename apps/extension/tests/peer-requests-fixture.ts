import { vi } from "vite-plus/test";
import type { PeerRequestDependencies } from "@/background/peer-requests";
import type { FolderAccess } from "@/p2p/folder-store";
import type { PeerMessage, PeerType, SharedTabs } from "@/p2p/protocol";
import type { AuthorizedPeer, PeerLink, RemoteRecording } from "@/storage/peer-repository";
import { memoryRecordingStore } from "./fake-extension";
import {
  FINGERPRINT,
  ME,
  PEER,
  STRANGER,
  fromPeer,
  memoryRecords,
  memoryRepository,
  recordingChannel,
} from "./fake-peer";

export const identity = { profileId: ME, displayName: "Laptop" };
export const peer: AuthorizedPeer = {
  profileId: PEER,
  displayName: "Desk",
  fingerprint: FINGERPRINT,
};
/** A second paired profile. */
export const other: AuthorizedPeer = {
  profileId: STRANGER,
  displayName: "Studio",
  fingerprint: "12:34:56",
};
export const VERIFIED: PeerLink = { state: "connected", verified: true };
export const TAB = {
  id: 3,
  windowId: 1,
  incognito: false as const,
  title: "Shop",
  url: "https://s/",
};

export const result = (ok: boolean, reason?: string) =>
  fromPeer("COMMAND_RESULT", { requestId: crypto.randomUUID(), ok, ...(reason ? { reason } : {}) });

/** The folder's pauses in memory, as the folder pairing keeps them. */
function memoryFolder() {
  const paused = new Set<string>();
  return {
    access: vi.fn(async (): Promise<FolderAccess> => "granted"),
    waiting: vi.fn(async () => false),
    paused: async () => [...paused],
    start: vi.fn(async () => {}),
    pause: vi.fn(async (id: string) => void paused.add(id)),
    unpause: vi.fn(async (id: string) => void paused.delete(id)),
    unpauseAll: vi.fn(async () => paused.clear()),
    release: vi.fn(async () => {}),
  };
}

/** Every dependency in memory, paired with `peer`; the channel answers each request with `reply`. */
export function requests(link: PeerLink | null = VERIFIED, reply: PeerMessage = result(true)) {
  const deps = {
    channel: {
      request: vi.fn(async (_to: string, _type: PeerType, _payload: unknown) => reply),
      send: recordingChannel().channel.send,
    },
    hello: vi.fn(async () => {}),
    askLink: vi.fn(async () => "link"),
    identity: async () => identity,
    rename: vi.fn(async () => {}),
    authorized: memoryRecords<AuthorizedPeer>({ [PEER]: peer }),
    link: memoryRecords<PeerLink>(link ? { [PEER]: link } : {}),
    mirror: memoryRecords<RemoteRecording>({
      [PEER]: { profileId: PEER, session: null, mine: false, connected: true },
    }),
    localSession: memoryRecordingStore(),
    controller: memoryRepository<{ profileId: string }>(),
    tabs: memoryRecords<SharedTabs>(),
    folder: memoryFolder(),
  } satisfies PeerRequestDependencies;
  const asked = () => deps.channel.request.mock.calls;
  return { deps, asked };
}

/** `requests`, also paired with `other` over a verified link. */
export async function withOther(link: PeerLink | null = VERIFIED) {
  const paired = requests(link);
  await paired.deps.authorized.set(STRANGER, other);
  await paired.deps.link.set(STRANGER, VERIFIED);
  return paired;
}
