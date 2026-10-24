import { afterEach, expect, test, vi } from "vite-plus/test";
import { createPeerChannel, NOT_CONNECTED } from "@/background/peer-channel";
import type { PeerChannelDependencies } from "@/background/peer-channel";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage } from "@/p2p/protocol";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { verified?: boolean; delivered?: boolean } = {}) {
  const frames: PeerMessage[] = [];
  const log: string[] = [];
  const state = { verified: options.verified ?? true };
  const deps: PeerChannelDependencies = {
    askLink: async (command) => {
      if (command.type === "link-send") frames.push(JSON.parse(command.frame) as PeerMessage);
      return { sent: options.delivered ?? true };
    },
    identity: async () => ({ profileId: ME, displayName: "Home" }),
    authorized: { read: async () => ({ profileId: PEER, displayName: "Work", fingerprint: "AB" }) },
    link: { read: async () => ({ state: "connected" as const, verified: state.verified }) },
    log: (entry) => log.push(entry),
  };
  return { channel: createPeerChannel(deps), frames, log, state };
}

const fromPeer = (message: PeerMessage) => JSON.stringify(message);

test("sends to the authorized peer only once the link is verified", async () => {
  const { channel, frames, state } = setup({ verified: false });
  await expect(channel.send("GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
  expect(frames).toEqual([]);
  state.verified = true;
  await channel.send("GET_TABS", {});
  expect(frames).toMatchObject([{ type: "GET_TABS", from: ME, to: PEER }]);
});

test("fails a send the link could not deliver", async () => {
  const { channel } = setup({ delivered: false });
  await expect(channel.send("GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
  await expect(channel.request("GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
});

test("pairs a reply with its request", async () => {
  const { channel, frames } = setup();
  const reply = channel.request("PING", { timestamp: 1 });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  const [ping] = frames;
  const pong = peerMessage(
    "PONG",
    { from: PEER, to: ME },
    { requestId: ping?.id ?? "", timestamp: 2 },
  );
  expect(await channel.receive(fromPeer(pong))).toEqual(pong);
  expect(await reply).toEqual(pong);
});

test("gives up on a request the peer never answers", async () => {
  vi.useFakeTimers();
  const { channel } = setup();
  const reply = channel.request("PING", { timestamp: 1 });
  const failed = expect(reply).rejects.toThrow("did not answer in time");
  await vi.advanceTimersByTimeAsync(5_000);
  await failed;
});

test("fails every request in flight when the link drops", async () => {
  const { channel, frames } = setup();
  const replies = [channel.request("GET_TABS", {}), channel.request("GET_SESSION", {})];
  await vi.waitFor(() => expect(frames).toHaveLength(2));
  channel.failAll();
  for (const reply of replies) await expect(reply).rejects.toThrow(NOT_CONNECTED);
});

test.each([
  ["an invalid frame", () => "{}", "invalid frame"],
  [
    "a stranger",
    () => fromPeer(peerMessage("GET_TABS", { from: STRANGER, to: ME }, {})),
    "unauthorized",
  ],
  [
    "another addressee",
    () => fromPeer(peerMessage("GET_TABS", { from: PEER, to: STRANGER }, {})),
    "unauthorized",
  ],
])("drops %s", async (_name, frame, reason) => {
  const { channel, log } = setup();
  expect(await channel.receive(frame())).toBeUndefined();
  expect(log.at(-1)).toContain(reason);
});

test("drops the authorized peer's frames until its certificate is verified", async () => {
  const { channel, log } = setup({ verified: false });
  const frame = fromPeer(peerMessage("GET_TABS", { from: PEER, to: ME }, {}));
  expect(await channel.receive(frame)).toBeUndefined();
  expect(log.at(-1)).toContain("unverified");
});
