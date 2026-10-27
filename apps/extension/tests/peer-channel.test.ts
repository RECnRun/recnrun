import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { NOT_CONNECTED, createPeerChannel } from "@/background/peer-channel";
import type { LinkCommand } from "@/messaging/peer-messages";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage } from "@/p2p/protocol";
import type { AuthorizedPeer, PeerLink } from "@/storage/peer-repository";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "99999999-9999-4999-8999-999999999999";

interface Setup {
  peer?: AuthorizedPeer | null;
  link?: PeerLink | null;
  askLink?: (command: LinkCommand) => Promise<unknown>;
  replyTimeoutMs?: number;
}

function channel(setup: Setup = {}) {
  const sent: PeerMessage[] = [];
  const log = vi.fn<(entry: string) => void>();
  const transmit = async (command: LinkCommand) => {
    if (command.type === "send") sent.push(JSON.parse(command.frame) as PeerMessage);
    return { sent: true };
  };
  const peer = setup.peer === undefined ? authorizedPeer() : setup.peer;
  const link =
    setup.link === undefined ? { state: "connected" as const, verified: true } : setup.link;
  const created = createPeerChannel({
    askLink: setup.askLink ?? transmit,
    identity: async () => ({ profileId: ME, displayName: "Me" }),
    authorized: { read: async () => peer },
    link: { read: async () => link },
    log,
    replyTimeoutMs: setup.replyTimeoutMs,
  });
  return { ...created, sent, log };
}

function authorizedPeer(): AuthorizedPeer {
  return { profileId: PEER, displayName: "Peer", fingerprint: "AB:CD" };
}

const fromPeer = (requestId: string) =>
  JSON.stringify(peerMessage("TABS_SNAPSHOT", { from: PEER, to: ME }, { requestId, tabs: [] }));

afterEach(() => {
  vi.useRealTimers();
});

describe("send", () => {
  test("addresses the authorized peer and logs only the type", async () => {
    const { send, sent, log } = channel();
    const message = await send("HELLO", { displayName: "Me", extensionVersion: "0.1.0" });
    expect(message).toMatchObject({ from: ME, to: PEER, type: "HELLO", displayName: "Me" });
    expect(sent).toEqual([message]);
    expect(log).toHaveBeenCalledWith("sent HELLO");
  });

  test.each([
    ["no authorized peer", { peer: null }],
    ["no link", { link: null }],
    ["an unverified link", { link: { state: "connected" as const, verified: false } }],
    ["a link that did not send", { askLink: async () => ({ sent: false }) }],
    ["a link that did not answer", { askLink: async () => undefined }],
  ])("fails with %s", async (_, setup: Setup) => {
    const { send, log } = channel(setup);
    await expect(send("GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("request", () => {
  test("resolves with the reply that names it, ignoring others", async () => {
    const { request, receive, sent } = channel();
    const reply = request("GET_TABS", {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const other = await receive(fromPeer("44444444-4444-4444-8444-444444444444"));
    expect(other.kind).toBe("accepted");
    const answer = fromPeer(sent[0]?.id ?? "");
    await receive(answer);
    expect(await reply).toEqual(JSON.parse(answer));
  });

  test("fails when no reply comes in time", async () => {
    vi.useFakeTimers();
    const { request } = channel({ replyTimeoutMs: 100 });
    const reply = expect(request("GET_TABS", {})).rejects.toThrow(
      "The other profile did not answer in time.",
    );
    await vi.advanceTimersByTimeAsync(100);
    await reply;
  });

  test("waits five seconds by default", async () => {
    vi.useFakeTimers();
    const { request } = channel();
    const settled = vi.fn();
    const reply = request("GET_TABS", {}).catch(settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reply;
    expect(settled).toHaveBeenCalledWith(new Error("The other profile did not answer in time."));
  });

  test("fails at once when the link cannot send", async () => {
    const failing = channel({ askLink: async () => Promise.reject(new Error("closed")) });
    await expect(failing.request("GET_TABS", {})).rejects.toThrow("closed");
    const refusing = channel({ askLink: async () => Promise.reject("closed") });
    await expect(refusing.request("GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
    const silent = channel({ askLink: async () => ({ sent: false }) });
    await expect(silent.request("GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
  });

  test("fails every waiting request when the link drops", async () => {
    const { request, failAll, sent } = channel();
    const replies = [request("GET_TABS", {}), request("SESSION_STOP", {})];
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    failAll();
    for (const reply of replies) await expect(reply).rejects.toThrow(NOT_CONNECTED);
  });
});

describe("receive", () => {
  test("accepts a message the authorized peer addressed to this profile", async () => {
    const { receive, log } = channel();
    const ask = peerMessage("GET_TABS", { from: PEER, to: ME }, {});
    expect(await receive(JSON.stringify(ask))).toEqual({ kind: "accepted", message: ask });
    expect(log).toHaveBeenCalledWith("received GET_TABS");
  });

  test("drops a frame that does not parse", async () => {
    const { receive, log } = channel();
    expect(await receive("{")).toEqual({ kind: "invalid" });
    expect(log).not.toHaveBeenCalled();
  });

  test.each([
    ["another sender", { from: STRANGER, to: ME }, {}],
    ["another recipient", { from: PEER, to: STRANGER }, {}],
    ["no authorized peer", { from: PEER, to: ME }, { peer: null }],
    ["no link", { from: PEER, to: ME }, { link: null }],
    [
      "an unverified link",
      { from: PEER, to: ME },
      { link: { state: "connecting", verified: false } },
    ],
  ] as const)("refuses a message with %s", async (_, route, setup: Setup) => {
    const { receive, log } = channel(setup);
    const ask = peerMessage("GET_TABS", route, {});
    expect(await receive(JSON.stringify(ask))).toEqual({ kind: "unauthorized" });
    expect(log).not.toHaveBeenCalled();
  });
});
