import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { ask, PeerRequestSchema } from "@/messaging/peer-protocol";
import {
  decodePairing,
  encodePairing,
  fingerprintOf,
  shortAuthenticationString,
} from "@/p2p/pairing-code";
import { MAX_MESSAGE_BYTES, parsePeerFrame, peerMessage } from "@/p2p/protocol";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const route = { from: A, to: B };
const FINGERPRINT = "AB:CD:EF:01";
const SDP = `v=0\r\na=fingerprint:sha-256 ${FINGERPRINT.toLowerCase()}\r\n`;

const tab = {
  id: 7,
  windowId: 1,
  incognito: false as const,
  title: "Shop",
  url: "https://shop.example/",
};

test("parses every message it builds", () => {
  const ping = peerMessage("PING", route, { timestamp: 5 });
  expect(parsePeerFrame(JSON.stringify(ping))).toEqual(ping);
  const tabs = peerMessage("TABS_CHANGED", route, { tabs: [tab], currentId: 7 });
  expect(parsePeerFrame(JSON.stringify(tabs))).toEqual(tabs);
});

test.each([
  ["a non-string frame", 42],
  ["text that is not JSON", "{not json"],
  [
    "an unknown type",
    JSON.stringify({ ...peerMessage("PING", route, { timestamp: 1 }), type: "EVAL" }),
  ],
  ["an extra field", JSON.stringify({ ...peerMessage("GET_TABS", route, {}), script: "alert(1)" })],
  ["another protocol", JSON.stringify({ ...peerMessage("GET_TABS", route, {}), protocol: 2 })],
  [
    "a sender that is not a profile id",
    JSON.stringify(peerMessage("GET_TABS", { from: "x", to: B }, {})),
  ],
  [
    "an incognito tab",
    JSON.stringify(
      peerMessage("TABS_CHANGED", route, { tabs: [{ ...tab, incognito: true as false }] }),
    ),
  ],
  ["an oversized frame", JSON.stringify({ pad: "x".repeat(MAX_MESSAGE_BYTES) })],
])("drops %s", (_name, frame) => {
  expect(parsePeerFrame(frame)).toBeUndefined();
});

const pairing = {
  kind: "offer" as const,
  pairingId: "33333333-3333-4333-8333-333333333333",
  profileId: A,
  displayName: "Work — José",
  expiresAt: 10_000,
  sdp: SDP,
};

test("round-trips a pairing code as one line of text", () => {
  const code = encodePairing(pairing);
  expect(code).toMatch(/^RECNRUN-PAIR-1\.[\w-]+$/);
  expect(decodePairing(` ${code}\n`, 9_999)).toEqual(pairing);
});

test.each([
  ["text from elsewhere", "hello", "not a RECnRun pairing code"],
  ["a damaged code", "RECNRUN-PAIR-1.%%%", "damaged"],
  ["a code with an unknown field", encodePairing({ ...pairing, token: "x" } as never), "damaged"],
  ["an expired code", encodePairing(pairing), "expired"],
])("refuses %s", (_name, code, reason) => {
  expect(() => decodePairing(code, 10_000)).toThrow(reason);
});

test("reads the certificate fingerprint an SDP announces", () => {
  expect(fingerprintOf(SDP)).toBe(FINGERPRINT);
  expect(fingerprintOf("v=0\r\n")).toBeUndefined();
});

test("derives the same six digits on both sides, and others for another certificate", async () => {
  const mine = await shortAuthenticationString("AA:01", "BB:02");
  expect(mine).toMatch(/^\d{6}$/);
  expect(await shortAuthenticationString("BB:02", "AA:01")).toBe(mine);
  expect(await shortAuthenticationString("AA:01", "CC:03")).not.toBe(mine);
});

test("caps a profile name at the length an identity may hold", () => {
  const rename = (displayName: string) =>
    v.safeParse(PeerRequestSchema, { target: "background", type: "peer-rename", displayName });
  expect(rename("  Work  ").output).toMatchObject({ displayName: "Work" });
  expect(rename("x".repeat(65)).success).toBe(false);
});

test("unwraps a reply, and turns a refusal or silence into an error", async () => {
  expect(await ask(async () => ({ ok: true, result: 3 }), {})).toBe(3);
  await expect(ask(async () => ({ ok: false, error: "No." }), {})).rejects.toThrow("No.");
  await expect(ask(async () => undefined, {})).rejects.toThrow("did not answer");
});
