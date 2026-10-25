import type { RecordingSession } from "@recnrun/domain";
import * as v from "valibot";
import { SharedTabsSchema } from "@/p2p/protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { TabSource } from "@/ports/tabs";
import type { PeerClient } from "@/views/peer-client";

/** The other profile as this profile's pages see it: its tabs, and the session this one controls. */
export interface PeerServices {
  client: PeerClient;
  tabs: TabSource;
  recordings: RecordingStore;
  openPairing: () => Promise<void>;
}

/** The background's copy of the executor's last report, as session storage keeps it. */
interface Mirror {
  read: () => Promise<{
    session: RecordingSession | null;
    mine: boolean;
    connected: boolean;
  } | null>;
  watch: (onChange: () => void) => () => void;
}

const ignored = v.unknown();

/** The peer's tabs as the background last heard them; a report from the peer is a change. */
export function remoteTabs(client: PeerClient): TabSource {
  return {
    read: () => client.ask({ type: "tabs" }, SharedTabsSchema),
    watch: (onChange) => client.watch(onChange),
  };
}

/**
 * The session this profile runs in the other one, from the executor's last report while the link
 * carries reports; a write is a command to the executor, which alone changes it, and the next
 * report shows the outcome.
 */
export function remoteRecordings(client: PeerClient, mirror: Mirror): RecordingStore {
  const read = async () => {
    const remote = await mirror.read();
    // A copy from a link that went down is no session to show or to control.
    return remote?.mine && remote.connected ? remote.session : null;
  };
  const write = async (next: RecordingSession | null) => {
    if (next === null) return void (await client.ask({ type: "session-stop" }, ignored));
    await client.ask({ type: "session-set", status: next.status }, ignored);
  };
  return { read, write, watch: (onChange) => mirror.watch(onChange) };
}

/**
 * The PiP window floats one session: this profile's own, or else the one it controls in the
 * other profile. Each read decides, as either can start or end at any time.
 */
export function eitherSession(
  local: { recordings: RecordingStore; tabs: TabSource },
  remote: Pick<PeerServices, "recordings" | "tabs">,
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
