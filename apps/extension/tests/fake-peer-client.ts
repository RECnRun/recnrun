import * as v from "valibot";
import type { PeerRequest } from "@/messaging/peer-messages";
import type { PeerEntry, PeerStatus } from "@/messaging/peer-results";
import type { PeerClient } from "@/views/peer-client";

const ALICE = { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Alice" };
const BOB = { profileId: "22222222-2222-4222-8222-222222222222", displayName: "Bob" };
const CAROL = { profileId: "33333333-3333-4333-8333-333333333333", displayName: "Carol" };
export const BOB_ID = BOB.profileId;
export const CAROL_ID = CAROL.profileId;

type Link = PeerEntry["link"];

/** This profile as Alice, paired with Bob unless `state` is undefined. */
export function statusOf(state?: Link["state"], verified = state === "connected"): PeerStatus {
  const bob = (link: Link) => ({
    peer: { ...BOB, fingerprint: "AB:CD:EF" },
    link,
    peerSession: null,
  });
  return {
    identity: ALICE,
    peers: state ? [bob({ state, verified })] : [],
    controlledBy: null,
    paused: [],
    folder: "granted",
    folderPairing: false,
    unpaired: [],
  };
}

/** Changes Bob's entry in `status`. */
const withBob = (status: PeerStatus, change: (bob: PeerEntry) => PeerEntry): PeerStatus => ({
  ...status,
  peers: status.peers.map((each) => (each.peer.profileId === BOB_ID ? change(each) : each)),
});

/** `status`, also paired with Carol, whose link is verified unless `link` says otherwise. */
export const withCarol = (
  status: PeerStatus,
  link: Link = { state: "connected", verified: true },
  peerSession: PeerEntry["peerSession"] = null,
): PeerStatus => ({
  ...status,
  peers: [...status.peers, { peer: { ...CAROL, fingerprint: "12:34:56" }, link, peerSession }],
});

/** Bob's session as Alice last heard of it. */
export const withPeerSession = (status: PeerStatus, peerSession: PeerEntry["peerSession"]) =>
  withBob(status, (bob) => ({ ...bob, peerSession }));

/** A link to Bob that went down for `reason`. */
export const closedFor = (state: Link["state"], reason: NonNullable<Link["reason"]>) =>
  withBob(statusOf(state, false), (bob) => ({ ...bob, link: { ...bob.link, reason } }));

/** Bob, whom the user disconnected, waits for Reconnect. */
export const pausedBob = (status: PeerStatus): PeerStatus => ({ ...status, paused: [BOB_ID] });

/** Bob started the session that runs in Alice's profile. */
export const controlledByBob = (status: PeerStatus): PeerStatus => ({
  ...status,
  controlledBy: BOB_ID,
});

type Answers = Partial<Record<PeerRequest["type"], (request: PeerRequest) => unknown>>;

/**
 * The background as a page's `PeerClient` reaches it: each request recorded and answered from
 * `answers` (an empty result by default, the current status for `status`), and validated the
 * way the real client validates a reply. A throwing answer is the background's error.
 */
export function fakePeerClient(initial: PeerStatus, answers: Answers = {}) {
  let status = initial;
  const requests: PeerRequest[] = [];
  const listeners = new Set<() => void>();
  const answer = (request: PeerRequest) =>
    answers[request.type]?.(request) ?? (request.type === "status" ? status : {});
  const client: PeerClient = {
    ask: async (request, schema) => {
      requests.push(request);
      return v.parse(schema, await Promise.resolve(answer(request)));
    },
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  /** The background's notice that the link or the peer changed. */
  const change = (next: PeerStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  const asked = (type: PeerRequest["type"]) => requests.filter((each) => each.type === type);
  return { client, requests, change, asked };
}
