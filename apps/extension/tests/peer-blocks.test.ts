import { expect, test } from "vite-plus/test";
import { peerBlocks } from "@/dashboard/peer-blocks";
import type { PeerView } from "@/views/peer-view";

const connected: PeerView = {
  identity: { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Laptop" },
  peer: {
    profileId: "22222222-2222-4222-8222-222222222222",
    displayName: "Desk",
    fingerprint: "AB:CD:EF",
  },
  link: { state: "connected", verified: true },
  peerSession: null,
  controlledByPeer: false,
  paused: false,
  folder: "granted",
  folderPairing: false,
  unpaired: [],
};
const DESK = connected.peer.profileId;
const STUDIO = "33333333-3333-4333-8333-333333333333";
const studio: PeerView = {
  ...connected,
  peer: { ...connected.peer, profileId: STUDIO, displayName: "Studio" },
};
const down: PeerView = { ...connected, link: { state: "disconnected", verified: false } };
const recording = (mine: boolean, live = true) => ({ status: "recording" as const, mine, live });

test.each<[string, PeerView, boolean, { local?: string; remote?: string }]>([
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
  const { local, remotes } = peerBlocks([status], localRunning);
  const remote = remotes[DESK];
  expect({ ...(local && { local }), ...(remote && { remote }) }).toEqual(blocks);
});

test("one session across every peer: a session in one blocks Record in the others' lists", () => {
  expect(peerBlocks([{ ...connected, peerSession: recording(false) }, studio], false)).toEqual({
    local: "Recording in Desk",
    remotes: { [DESK]: "Recording in Desk", [STUDIO]: "Recording in Desk" },
  });
  expect(peerBlocks([{ ...connected, peerSession: recording(true) }, studio], false)).toEqual({
    local: "Recording in Desk",
    remotes: { [STUDIO]: "Recording in Desk" },
  });
  expect(peerBlocks([connected, { ...studio, controlledByPeer: true }], true)).toEqual({
    local: "Controlled from Studio",
    remotes: { [DESK]: "Recording in Laptop", [STUDIO]: "Recording in Laptop" },
  });
});
