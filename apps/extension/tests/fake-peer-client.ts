import * as v from "valibot";
import type { PeerRequest } from "@/messaging/peer-messages";
import type { PeerStatus } from "@/messaging/peer-results";
import { encodePairing } from "@/p2p/pairing-code";
import type { PeerClient } from "@/views/peer-client";

export const ALICE = { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Alice" };
export const BOB = { profileId: "22222222-2222-4222-8222-222222222222", displayName: "Bob" };

type LinkState = PeerStatus["link"]["state"];

/** This profile as Alice, paired with Bob unless `state` is undefined. */
export function statusOf(state?: LinkState, verified = state === "connected"): PeerStatus {
  return {
    identity: ALICE,
    peer: state ? { ...BOB, fingerprint: "AB:CD:EF" } : null,
    link: { state: state ?? "idle", verified },
  };
}

/** A real pairing code, so the folder can name its file after the code's own fields. */
export function pairingCode(
  kind: "offer" | "answer",
  maker: typeof ALICE,
  pairingId: string,
  ttlMs = 60_000,
): string {
  const expiresAt = Date.now() + ttlMs;
  return encodePairing({ kind, pairingId, ...maker, expiresAt, sdp: `v=0 ${kind}` });
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
