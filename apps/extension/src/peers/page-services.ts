import { browser } from "wxt/browser";
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
  return {
    client,
    tabsOf: (peer) => remoteTabs(client, peer),
    recordings: remoteRecordings(client, mirror),
    sessionTabs: remoteSessionTabs(client, mirror),
    openFolder: async () => {
      // Production builds have no folder window, so the typed public paths leave it out.
      const url = new URL("folder.html", browser.runtime.getURL("/")).href;
      await browser.windows.create({ url, type: "popup", width: 480, height: 360 });
    },
  };
}
