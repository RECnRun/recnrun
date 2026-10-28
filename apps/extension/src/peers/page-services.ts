import { allowFolder, chooseFolder } from "@/p2p/folder-store";
import { remoteRecordingsRepository } from "@/storage/peer-repository";
import { createPeerClient } from "@/views/peer-client";
import { remoteRecordings, remoteSessionTabs, remoteTabs } from "@/views/remote-peer";
import type { PeerServices } from "@/views/remote-peer";

/** The paired profiles, through this extension's background and its session storage. */
export function peerServices(): PeerServices {
  const client = createPeerClient();
  const mirror = {
    // One session runs at a time, so at most one peer's is this profile's.
    read: async () =>
      Object.values(await remoteRecordingsRepository.all()).find(({ mine }) => mine) ?? null,
    watch: remoteRecordingsRepository.watch,
  };
  const mirrorOf = (peer: string) => ({
    read: () => remoteRecordingsRepository.get(peer),
    watch: remoteRecordingsRepository.watch,
  });
  return {
    client,
    tabsOf: (peer) => remoteTabs(client, peer),
    recordingsOf: (peer) => remoteRecordings(client, mirrorOf(peer)),
    recordings: remoteRecordings(client, mirror),
    sessionTabs: remoteSessionTabs(client, mirror),
    chooseFolder,
    allowFolder,
  };
}
