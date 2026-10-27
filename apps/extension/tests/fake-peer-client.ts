import * as v from "valibot";
import type { PeerRequest } from "@/messaging/peer-messages";
import type { PeerStatus } from "@/messaging/peer-results";
import type { PeerClient } from "@/views/peer-client";

const ALICE = { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Alice" };
const BOB = { profileId: "22222222-2222-4222-8222-222222222222", displayName: "Bob" };

type Link = PeerStatus["link"];

/** This profile as Alice, paired with Bob unless `state` is undefined. */
export function statusOf(state?: Link["state"], verified = state === "connected"): PeerStatus {
  return {
    identity: ALICE,
    peer: state ? { ...BOB, fingerprint: "AB:CD:EF" } : null,
    link: { state: state ?? "idle", verified },
    peerSession: null,
    controlledByPeer: false,
    folder: "granted",
    folderPairing: false,
  };
}

/** Bob's session as Alice last heard of it. */
export function withPeerSession(
  status: PeerStatus,
  peerSession: NonNullable<PeerStatus["peerSession"]>,
): PeerStatus {
  return { ...status, peerSession };
}

/** A link that went down for `reason`. */
export function closedFor(state: Link["state"], reason: NonNullable<Link["reason"]>): PeerStatus {
  const status = statusOf(state, false);
  return { ...status, link: { ...status.link, reason } };
}

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
