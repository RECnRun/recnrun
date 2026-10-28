import { browser } from "wxt/browser";
import { remoteRecordingRepository } from "@/storage/peer-repository";
import { createPeerClient } from "@/views/peer-client";
import { remoteRecordings, remoteTabs } from "@/views/remote-peer";
import type { PeerServices } from "@/views/remote-peer";

/** The paired profile, through this extension's background and its session storage. */
export function peerServices(): PeerServices {
  const client = createPeerClient();
  return {
    client,
    tabs: remoteTabs(client),
    recordings: remoteRecordings(client, remoteRecordingRepository),
    openFolder: async () => {
      // Production builds have no folder window, so the typed public paths leave it out.
      const url = new URL("folder.html", browser.runtime.getURL("/")).href;
      await browser.windows.create({ url, type: "popup", width: 480, height: 360 });
    },
  };
}
