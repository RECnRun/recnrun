import * as v from "valibot";
import { FolderBanner, PairingSection } from "@/dashboard/FolderPairing";
import type { RemoteTake } from "@/dashboard/control";
import { peerBlocks } from "@/dashboard/peer-blocks";
import { TabList } from "@/dashboard/TabList";
import type { TakeControl } from "@/dashboard/TabList";
import { useMemo } from "preact/hooks";
import type { ExtensionServices } from "@/views/extension-services";
import { linkLabel } from "@/views/link-label";
import { peerViews } from "@/views/peer-view";
import type { PeerView } from "@/views/peer-view";
import { useRecording } from "@/views/recording";
import type { PeerServices } from "@/views/remote-peer";
import { usePeerStatus } from "@/views/use-peer";

interface PeerProfilesProps {
  services: Pick<ExtensionServices, "tabs" | "recordings">;
  peers: PeerServices;
  take: TakeControl;
  /** Takes the control of a session in another profile. */
  takeRemote: RemoteTake;
}

/** The tabs of a paired Chrome profile, which this dashboard can show and record. */
function RemoteProfile({
  peers,
  status,
  take,
  blocked,
}: {
  peers: PeerServices;
  status: PeerView;
  take: RemoteTake;
  blocked?: string;
}) {
  const peer = status.peer.profileId;
  // A new source each render would read the tabs again on every render.
  const tabs = useMemo(() => peers.tabsOf(peer), [peers, peer]);
  const recordings = useMemo(() => peers.recordingsOf(peer), [peers, peer]);
  const activate = (tabId: number) =>
    peers.client.ask({ type: "activate", peer, tabId }, v.unknown()).then(() => {});
  return (
    <TabList
      tabs={tabs}
      store={recordings}
      take={take(peer)}
      activate={status.link.verified ? activate : undefined}
      blocked={blocked}
      heading={{
        id: `remote-tabs-${peer}`,
        text: `Chrome — ${status.peer.displayName} (${linkLabel(status.link, status.peer.displayName)})`,
      }}
    />
  );
}

/**
 * Unpaired, the dashboard is the local one plus a way to pair; paired, this profile's tabs and
 * each paired profile's, each under the profile's name.
 */
export function PeerProfiles({ services, peers, take, takeRemote }: PeerProfilesProps) {
  const { status } = usePeerStatus(peers.client);
  const localRunning = useRecording(services.recordings).status !== "idle";
  const views = status ? peerViews(status) : [];
  const banner = <FolderBanner peers={peers} status={status} />;
  const pairing = <PairingSection peers={peers} status={status} />;
  if (!status || views.length === 0) {
    return (
      <>
        {banner}
        <TabList tabs={services.tabs} store={services.recordings} take={take} />
        {pairing}
      </>
    );
  }
  const blocks = peerBlocks(views, localRunning);
  return (
    <>
      {banner}
      <TabList
        tabs={services.tabs}
        store={services.recordings}
        take={take}
        heading={{ id: "tabs-heading", text: `Chrome — ${status.identity.displayName} (Local)` }}
        blocked={blocks.local}
      />
      {views.map((view) => (
        <RemoteProfile
          key={view.peer.profileId}
          peers={peers}
          status={view}
          take={takeRemote}
          blocked={blocks.remotes[view.peer.profileId]}
        />
      ))}
      {pairing}
    </>
  );
}
