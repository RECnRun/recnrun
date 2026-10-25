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
  status: PeerStatus;
  take: TakeControl;
}) {
  const peer = status.peer;
  if (!peer) return null;
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
        text: `Chrome — ${peer.displayName} (${peerState(status.link)})`,
      }}
    />
  );
}

/** This profile's tabs, then the paired profile's, each under the profile's name. */
export function PeerProfiles({ services, peers, take, takeRemote }: PeerProfilesProps) {
  const { status } = usePeerStatus(peers.client);
  const name = status?.identity.displayName ?? "This profile";
  return (
    <>
      <TabList
        tabs={services.tabs}
        store={services.recordings}
        take={take}
        heading={{ id: "tabs-heading", text: `Chrome — ${name} (Local)` }}
      />
      {status && <RemoteProfile peers={peers} status={status} take={takeRemote} />}
      <button type="button" onClick={() => void peers.openPairing()}>
        {status?.peer ? "Manage pairing" : "Pair another profile"}
      </button>
    </>
  );
}
