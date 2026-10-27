import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  LinkCommandMessageSchema,
  LinkEventSchema,
  PeerNoticeSchema,
  PeerRequestSchema,
  linkCommandMessage,
  linkEventMessage,
  peerNotice,
  peerRequestMessage,
} from "@/messaging/peer-messages";
import { MAX_FRAME_LENGTH } from "@/p2p/protocol";
import { PEER } from "./fake-peer";

const accepts = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;

test("accepts the page requests and rejects malformed ones", () => {
  expect(accepts(PeerRequestSchema, { type: "status" })).toBe(true);
  expect(accepts(PeerRequestSchema, { type: "rename", displayName: " Work " })).toBe(true);
  expect(accepts(PeerRequestSchema, { type: "activate", tabId: 2 })).toBe(true);
  expect(accepts(PeerRequestSchema, { type: "rename", displayName: "  " })).toBe(false);
  expect(accepts(PeerRequestSchema, { type: "create-offer" })).toBe(false);
  expect(accepts(PeerRequestSchema, { type: "activate", tabId: -1 })).toBe(false);
  expect(accepts(PeerRequestSchema, { type: "status", extra: 1 })).toBe(false);
  expect(accepts(PeerRequestSchema, { type: "explode" })).toBe(false);
});

test("wraps a page request for the background", () => {
  expect(peerRequestMessage({ type: "tabs" })).toEqual({ type: "peer", request: { type: "tabs" } });
});

test("accepts link events that name their peer, up to the frame limit", () => {
  const frame = (length: number) => ({ type: "frame", peer: PEER, frame: "x".repeat(length) });
  expect(accepts(LinkEventSchema, frame(MAX_FRAME_LENGTH))).toBe(true);
  expect(accepts(LinkEventSchema, frame(MAX_FRAME_LENGTH + 1))).toBe(false);
  expect(accepts(LinkEventSchema, { type: "state", peer: PEER, state: "connected" })).toBe(true);
  expect(accepts(LinkEventSchema, { type: "state", state: "connected" })).toBe(false);
  expect(accepts(LinkEventSchema, { type: "state", peer: PEER, state: "melted" })).toBe(false);
  const event = {
    type: "state" as const,
    peer: PEER,
    state: "failed" as const,
    remoteFingerprint: "AB",
  };
  expect(linkEventMessage(event)).toEqual({ type: "link", event });
});

test("addresses link commands to the offscreen document only, each to one peer's link", () => {
  const message = linkCommandMessage({ type: "answer", peer: PEER, sdp: "v=0" });
  expect(message).toEqual({
    target: "offscreen",
    command: { type: "answer", peer: PEER, sdp: "v=0" },
  });
  expect(accepts(LinkCommandMessageSchema, message)).toBe(true);
  expect(accepts(LinkCommandMessageSchema, { ...message, target: "pages" })).toBe(false);
  const offer = linkCommandMessage({ type: "offer", peer: PEER });
  expect(accepts(LinkCommandMessageSchema, offer)).toBe(true);
  for (const command of [
    { type: "send", frame: "{}" },
    { type: "close", peer: "nobody" },
  ])
    expect(accepts(LinkCommandMessageSchema, { target: "offscreen", command })).toBe(false);
  const empty = { target: "offscreen", command: { type: "answer", peer: PEER, sdp: "" } };
  expect(accepts(LinkCommandMessageSchema, empty)).toBe(false);
});

test("builds the notice every page listens for", () => {
  expect(accepts(PeerNoticeSchema, peerNotice())).toBe(true);
  expect(accepts(PeerNoticeSchema, { target: "pages", type: "other" })).toBe(false);
});

test("carries what the folder holds, and folder commands, only in their own shapes", () => {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const presence = {
    profileId,
    displayName: "Desk",
    fingerprint: "AB:CD",
    createdAt: 1,
    expiresAt: 2,
  };
  const sighting = (presences: unknown[]) => ({ type: "folder", presences, signals: [] });
  expect(accepts(LinkEventSchema, sighting([presence]))).toBe(true);
  expect(accepts(LinkEventSchema, sighting([{ ...presence, fingerprint: "ab:cd" }]))).toBe(false);
  const watch = { type: "folder-watch" as const, profileId, displayName: "Desk" };
  expect(accepts(LinkCommandMessageSchema, linkCommandMessage(watch))).toBe(true);
  const stranger = linkCommandMessage({ ...watch, profileId: "not-a-profile" });
  expect(accepts(LinkCommandMessageSchema, stranger)).toBe(false);
});
