import * as v from "valibot";
import { FolderBanner, PairControls } from "@/dashboard/FolderPairing";
import { peerBlocks } from "@/dashboard/peer-blocks";
import type { PairedStatus } from "@/dashboard/peer-blocks";
import { TabList } from "@/dashboard/TabList";
import type { TakeControl } from "@/dashboard/TabList";
import type { ExtensionServices } from "@/views/extension-services";
import { linkLabel } from "@/views/link-label";
import { useRecording } from "@/views/recording";
import type { PeerServices } from "@/views/remote-peer";
import { usePeerStatus } from "@/views/use-peer";

interface PeerProfilesProps {
  services: Pick<ExtensionServices, "tabs" | "recordings">;
  peers: PeerServices;
  take: TakeControl;
  /** Takes the control of a session in the other profile. */
  takeRemote: TakeControl;
}

/** The tabs of the paired Chrome profile, which this dashboard can show and record. */
function RemoteProfile({
  peers,
  status,
  take,
  blocked,
}: {
  peers: PeerServices;
  status: PairedStatus;
  take: TakeControl;
  blocked?: string;
}) {
  const activate = (tabId: number) =>
    peers.client.ask({ type: "activate", tabId }, v.unknown()).then(() => {});
  return (
    <TabList
      tabs={peers.tabs}
      store={peers.recordings}
      take={take}
      activate={status.link.verified ? activate : undefined}
      blocked={blocked}
      heading={{
        id: "remote-tabs-heading",
        text: `Chrome — ${status.peer.displayName} (${linkLabel(status.link, status.peer.displayName)})`,
      }}
    />
  );
}

/**
 * Unpaired, the dashboard is the local one plus a way to pair; paired, this profile's tabs and
 * the other profile's, each under the profile's name.
 */
export function PeerProfiles({ services, peers, take, takeRemote }: PeerProfilesProps) {
  const { status } = usePeerStatus(peers.client);
  const localRunning = useRecording(services.recordings).status !== "idle";
  const paired = status?.peer ? { ...status, peer: status.peer } : undefined;
  const banner = <FolderBanner peers={peers} status={status} />;
  const pairControls = <PairControls peers={peers} status={status} />;
  if (!paired) {
    return (
      <>
        {banner}
        <TabList tabs={services.tabs} store={services.recordings} take={take} />
        {pairControls}
      </>
    );
  }
  const blocks = peerBlocks(paired, localRunning);
  return (
    <>
      {banner}
      <TabList
        tabs={services.tabs}
        store={services.recordings}
        take={take}
        heading={{ id: "tabs-heading", text: `Chrome — ${paired.identity.displayName} (Local)` }}
        blocked={blocks.local}
      />
      <RemoteProfile peers={peers} status={paired} take={takeRemote} blocked={blocks.remote} />
      {pairControls}
    </>
  );
}
