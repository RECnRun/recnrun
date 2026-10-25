import { expect, test } from "vite-plus/test";
import { peerBlocks } from "@/dashboard/peer-blocks";
import type { PairedStatus } from "@/dashboard/peer-blocks";

const connected: PairedStatus = {
  identity: { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Laptop" },
  peer: {
    profileId: "22222222-2222-4222-8222-222222222222",
    displayName: "Desk",
    fingerprint: "AB:CD:EF",
  },
  link: { state: "connected", verified: true },
  peerSession: null,
  controlledByPeer: false,
};
const down: PairedStatus = { ...connected, link: { state: "disconnected", verified: false } };
const recording = (mine: boolean, live = true) => ({ status: "recording" as const, mine, live });

test.each<[string, PairedStatus, boolean, ReturnType<typeof peerBlocks>]>([
  ["nothing while no session runs", connected, false, {}],
  [
    "the other profile's list while one runs here",
    connected,
    true,
    { remote: "Recording in Laptop" },
  ],
  [
    "this profile's list while the peer controls its session",
    { ...connected, controlledByPeer: true },
    true,
    { local: "Controlled from Desk", remote: "Recording in Laptop" },
  ],
  [
    "both lists while the peer's own user records there",
    { ...connected, peerSession: recording(false) },
    false,
    { local: "Recording in Desk", remote: "Recording in Desk" },
  ],
  [
    "only this profile's list while it controls the session in the peer",
    { ...connected, peerSession: recording(true) },
    false,
    { local: "Recording in Desk" },
  ],
  [
    "the other profile's list without a link",
    down,
    false,
    {
      remote: "Not connected. These tabs are as last seen.",
    },
  ],
  [
    "the other profile's list, with its last session, but not this one's, without a link",
    { ...down, peerSession: recording(false, false) },
    false,
    { remote: "Not connected. Last seen recording." },
  ],
])("blocks %s", (_, status, localRunning, blocks) => {
  const { local, remote } = peerBlocks(status, localRunning);
  expect({ ...(local && { local }), ...(remote && { remote }) }).toEqual(blocks);
});
