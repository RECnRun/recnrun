import * as v from "valibot";
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

/** Leads to the folder page, since the framed dashboard cannot show Chrome's folder picker. */
function FolderBanner({ peers }: { peers: PeerServices }) {
  return (
    <section class="folder-banner" aria-labelledby="folder-banner-heading">
      <h3 id="folder-banner-heading">Choose the RECnRun folder</h3>
      <p>Your Chrome profiles pair through a folder named RECnRun in Documents.</p>
      <button type="button" onClick={() => void peers.openPairing()}>
        Choose folder
      </button>
    </section>
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
  const pairButton = (
    <button type="button" onClick={() => void peers.openPairing()}>
      {paired ? "Manage pairing" : "Pair another profile"}
    </button>
  );
  const banner = status && status.folder !== "granted" && <FolderBanner peers={peers} />;
  if (!paired) {
    return (
      <>
        {banner}
        <TabList tabs={services.tabs} store={services.recordings} take={take} />
        {pairButton}
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
      {pairButton}
    </>
  );
}
