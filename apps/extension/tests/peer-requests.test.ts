import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { handlePeerRequest } from "@/background/peer-requests";
import type { PeerRequestDependencies } from "@/background/peer-requests";
import { peerRequest } from "@/messaging/peer-protocol";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage, PeerType } from "@/p2p/protocol";
import {
  authorizedPeerRepository,
  identityRepository,
  peerLinkRepository,
  readIdentity,
  remoteRecordingRepository,
  watchPeer,
} from "@/storage/peer-repository";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const peer = { profileId: PEER, displayName: "Work", fingerprint: "AB:CD" };

beforeEach(() => {
  fakeBrowser.reset();
});

/** The peer answers each request with what `answers` says for its type. */
function setup(answers: Partial<Record<PeerType, (sent: PeerMessage) => PeerMessage>> = {}) {
  const requests: PeerType[] = [];
  const closeLink = vi.fn(async () => {});
  const deps: PeerRequestDependencies = {
    channel: {
      request: async (type, payload) => {
        requests.push(type);
        const sent = peerMessage(type, { from: ME, to: PEER }, payload as never);
        const answer = answers[type];
        if (!answer) throw new Error("No answer.");
        return answer(sent);
      },
    },
    pairing: { createOffer: vi.fn(), inspect: vi.fn(), accept: vi.fn() },
    closeLink,
    diagnostics: async () => ({ diagnostics: ["link connected"] }),
    identity: readIdentity,
    rename: (identity) => identityRepository.write(identity),
    authorized: authorizedPeerRepository,
    link: peerLinkRepository,
    mirror: remoteRecordingRepository,
    localSession: { read: async () => null },
  };
  const run = (request: Parameters<typeof peerRequest>[0]) =>
    handlePeerRequest(deps, peerRequest(request));
  return { deps, requests, closeLink, run };
}

const result = (ok: boolean, reason?: string) => (sent: PeerMessage) =>
  peerMessage("COMMAND_RESULT", { from: PEER, to: ME }, { requestId: sent.id, ok, reason });

test("creates an identity once and keeps it, renamed", async () => {
  const { run } = setup();
  const first = (await run({ type: "peer-status" })) as { identity: { profileId: string } };
  await run({ type: "peer-rename", displayName: "Home" });
  expect(await run({ type: "peer-status" })).toEqual({
    identity: { profileId: first.identity.profileId, displayName: "Home" },
    peer: null,
    link: { state: "idle", verified: false },
  });
});

test("reads an identity that no longer matches its schema as missing", async () => {
  await fakeBrowser.storage.local.set({ profileIdentity: { profileId: "not-a-uuid" } });
  expect(await identityRepository.read()).toBeNull();
});

test("lists no remote tabs while the link is not verified", async () => {
  const { run, requests } = setup();
  expect(await run({ type: "peer-tabs" })).toEqual({ tabs: [] });
  expect(requests).toEqual([]);
});

test("lists the peer's tabs once connected", async () => {
  await peerLinkRepository.write({ state: "connected", verified: true });
  const tab = { id: 3, windowId: 1, incognito: false as const, title: "Shop", url: "https://s/" };
  const { run } = setup({
    GET_TABS: (sent) =>
      peerMessage(
        "TABS_SNAPSHOT",
        { from: PEER, to: ME },
        { requestId: sent.id, tabs: [tab], currentId: 3 },
      ),
  });
  expect(await run({ type: "peer-tabs" })).toEqual({ tabs: [tab], currentId: 3 });
});

test("measures a ping", async () => {
  const { run } = setup({
    PING: (sent) =>
      peerMessage("PONG", { from: PEER, to: ME }, { requestId: sent.id, timestamp: 1 }),
  });
  expect(await run({ type: "peer-ping" })).toEqual({ latencyMs: expect.any(Number) });
});

test("passes on what the executor refused", async () => {
  const { run } = setup({ ACTIVATE_TAB: result(false, "That tab is not open anymore.") });
  await expect(run({ type: "peer-activate", tabId: 3 })).rejects.toThrow("not open anymore");
});

test("starts, pauses, and stops a remote session", async () => {
  const { run, requests } = setup({
    SESSION_START: result(true),
    SESSION_SET_STATUS: result(true),
    SESSION_STOP: result(true),
  });
  await run({ type: "remote-session-start", tabId: 3 });
  await run({ type: "remote-session-set", status: "paused" });
  await run({ type: "remote-session-stop" });
  expect(requests).toEqual(["SESSION_START", "SESSION_SET_STATUS", "SESSION_STOP"]);
});

test("refuses a remote session while one runs here", async () => {
  const { deps, run, requests } = setup({ SESSION_START: result(true) });
  deps.localSession = {
    read: async () => ({ tabId: 1, status: "recording", banked: 0, since: 1 }),
  };
  await expect(run({ type: "remote-session-start", tabId: 3 })).rejects.toThrow("already runs");
  expect(requests).toEqual([]);
});

test("forgets the peer, its session copy, and the link", async () => {
  await authorizedPeerRepository.write(peer);
  await remoteRecordingRepository.write({
    profileId: PEER,
    displayName: "Work",
    session: null,
    controlledBy: null,
    link: "connected",
  });
  const { run, closeLink } = setup();
  await run({ type: "peer-forget" });
  expect(await authorizedPeerRepository.read()).toBeNull();
  expect(await remoteRecordingRepository.read()).toBeNull();
  expect(closeLink).toHaveBeenCalled();
});

test("hands pairing, disconnect, and diagnostics to their owners", async () => {
  const { deps, run, closeLink } = setup();
  await run({ type: "peer-create-offer" });
  await run({ type: "peer-inspect", code: "c" });
  await run({ type: "peer-accept", code: "c" });
  await run({ type: "peer-disconnect" });
  await run({ type: "remote-session-forget" });
  expect(deps.pairing.createOffer).toHaveBeenCalled();
  expect(deps.pairing.inspect).toHaveBeenCalledWith("c");
  expect(deps.pairing.accept).toHaveBeenCalledWith("c");
  expect(closeLink).toHaveBeenCalled();
  expect(await run({ type: "peer-diagnostics" })).toEqual({ diagnostics: ["link connected"] });
});

test("tells the pairing page when the peer or the link changes", async () => {
  const changed = vi.fn();
  const stop = watchPeer(changed);
  await authorizedPeerRepository.write(peer);
  await peerLinkRepository.write({ state: "connecting", verified: false });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  stop();
  await peerLinkRepository.write({ state: "connected", verified: true });
  expect(changed).toHaveBeenCalledTimes(2);
});
