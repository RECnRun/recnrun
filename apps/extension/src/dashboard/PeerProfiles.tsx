import * as v from "valibot";
import type { PeerStatus } from "@/messaging/peer-results";
import { TabList } from "@/dashboard/TabList";
import type { TakeControl } from "@/dashboard/TabList";
import type { ExtensionServices } from "@/views/extension-services";
import type { PeerServices } from "@/views/remote-peer";
import { usePeerStatus } from "@/views/use-peer";

interface PeerProfilesProps {
  services: Pick<ExtensionServices, "tabs" | "recordings">;
  peers: PeerServices;
  take: TakeControl;
  /** Takes the control of a session in the other profile. */
  takeRemote: TakeControl;
}

const STATES = {
  idle: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  failed: "Error",
} as const;

/** The other profile's state in a word; a link whose certificate is unchecked is still connecting. */
function peerState(link: PeerStatus["link"]): string {
  return link.state === "connected" && !link.verified ? STATES.connecting : STATES[link.state];
}

/** The tabs of the paired Chrome profile, which this dashboard can show and record. */
function RemoteProfile({
  peers,
  status,
  take,
}: {
  peers: PeerServices;
  status: PeerStatus & { peer: NonNullable<PeerStatus["peer"]> };
  take: TakeControl;
}) {
  const activate = (tabId: number) =>
    peers.client.ask({ type: "activate", tabId }, v.unknown()).then(() => {});
  return (
    <TabList
      tabs={peers.tabs}
      store={peers.recordings}
      take={take}
      activate={activate}
      heading={{
        id: "remote-tabs-heading",
        text: `Chrome — ${status.peer.displayName} (${peerState(status.link)})`,
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
  const paired = status?.peer ? { ...status, peer: status.peer } : undefined;
  const pairButton = (
    <button type="button" onClick={() => void peers.openPairing()}>
      {paired ? "Manage pairing" : "Pair another profile"}
    </button>
  );
  if (!paired) {
    return (
      <>
        <TabList tabs={services.tabs} store={services.recordings} take={take} />
        {pairButton}
      </>
    );
  }
  return (
    <>
      <TabList
        tabs={services.tabs}
        store={services.recordings}
        take={take}
        heading={{ id: "tabs-heading", text: `Chrome — ${paired.identity.displayName} (Local)` }}
      />
      <RemoteProfile peers={peers} status={paired} take={takeRemote} />
      {pairButton}
    </>
  );
}
