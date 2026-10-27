import type { RecordingSession } from "@recnrun/domain";
import * as v from "valibot";
import { SharedTabsSchema } from "@/p2p/protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { TabSource } from "@/ports/tabs";
import type { PeerClient } from "@/views/peer-client";

/** The other profiles as this profile's pages see them: their tabs, and the session this one controls. */
export interface PeerServices {
  client: PeerClient;
  /** One peer's tabs. */
  tabsOf: (peer: string) => TabSource;
  /** The session this profile controls in one peer, as that peer's list shows it. */
  recordingsOf: (peer: string) => RecordingStore;
  /** The session this profile controls in any peer, if it controls one. */
  recordings: RecordingStore;
  /** The tabs of the peer that session runs in. */
  sessionTabs: TabSource;
  /** Opens the window that grants the RECnRun folder. */
  openFolder: () => Promise<void>;
}

/** The background's copy of the executor's last report, as session storage keeps it. */
interface Mirror {
  read: () => Promise<{
    profileId: string;
    session: RecordingSession | null;
    mine: boolean;
    connected: boolean;
  } | null>;
  watch: (onChange: () => void) => () => void;
}

const ignored = v.unknown();

/** A peer's tabs as the background last heard them; a report from any peer is a change. */
export function remoteTabs(client: PeerClient, peer: string): TabSource {
  return {
    read: () => client.ask({ type: "tabs", peer }, SharedTabsSchema),
    watch: (onChange) => client.watch(onChange),
  };
}

/** The peer's last report, while it is of a session this profile controls over a link that holds. */
async function controlled(mirror: Mirror) {
  const remote = await mirror.read();
  // A copy from a link that went down is no session to show or to control.
  return remote?.mine && remote.connected ? remote : null;
}

/** The tabs of the peer that runs the session this profile controls; none without one. */
export function remoteSessionTabs(client: PeerClient, mirror: Mirror): TabSource {
  const read = async () => {
    const remote = await controlled(mirror);
    return remote ? remoteTabs(client, remote.profileId).read() : { tabs: [] };
  };
  return { read, watch: (onChange) => client.watch(onChange) };
}

/**
 * The session this profile runs in the other one, from the executor's last report while the link
 * carries reports; a write is a command to the executor, which alone changes it, and the next
 * report shows the outcome.
 */
export function remoteRecordings(client: PeerClient, mirror: Mirror): RecordingStore {
  const read = async () => (await controlled(mirror))?.session ?? null;
  const write = async (next: RecordingSession | null) => {
    const remote = await controlled(mirror);
    if (!remote) throw new Error("This profile controls no session in another profile.");
    const peer = remote.profileId;
    if (next === null) return void (await client.ask({ type: "session-stop", peer }, ignored));
    await client.ask({ type: "session-set", peer, status: next.status }, ignored);
  };
  return { read, write, watch: (onChange) => mirror.watch(onChange) };
}

/**
 * The PiP window floats one session: this profile's own, or else the one it controls in the
 * other profile. Each read decides, as either can start or end at any time.
 */
export function eitherSession(
  local: { recordings: RecordingStore; tabs: TabSource },
  remote: { recordings: RecordingStore; tabs: TabSource },
): { recordings: RecordingStore; tabs: TabSource } {
  const pick = async () => ((await local.recordings.read()) ? local : remote);
  const both = (onChange: () => void) => {
    const unwatch = [local.recordings.watch(onChange), remote.recordings.watch(onChange)];
    return () => unwatch.forEach((stop) => stop());
  };
  const recordings: RecordingStore = {
    read: async () => (await pick()).recordings.read(),
    write: async (next) => (await pick()).recordings.write(next),
    watch: both,
  };
  const tabs: TabSource = {
    read: async () => (await pick()).tabs.read(),
    watch: (onChange) => {
      const unwatch = [both(onChange), local.tabs.watch(onChange), remote.tabs.watch(onChange)];
      return () => unwatch.forEach((stop) => stop());
    },
  };
  return { recordings, tabs };
}
