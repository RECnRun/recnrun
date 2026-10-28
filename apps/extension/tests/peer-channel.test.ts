import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { NOT_CONNECTED, createPeerChannel } from "@/background/peer-channel";
import type { LinkCommand } from "@/messaging/peer-messages";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage } from "@/p2p/protocol";
import type { AuthorizedPeer, PeerLink } from "@/storage/peer-repository";

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const OTHER = "33333333-3333-4333-8333-333333333333";
const UP: PeerLink = { state: "connected", verified: true };

interface Setup {
  peer?: AuthorizedPeer | null;
  link?: PeerLink | null;
  /** A second authorized peer, OTHER, with this link. */
  other?: PeerLink | null;
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
  const peer = setup.peer === undefined ? authorizedPeer(PEER) : setup.peer;
  const link = setup.link === undefined ? UP : setup.link;
  const other = setup.other === undefined ? null : setup.other;
  const peers: Record<string, AuthorizedPeer | null> = {
    [PEER]: peer,
    [OTHER]: other && authorizedPeer(OTHER),
  };
  const links: Record<string, PeerLink | null> = { [PEER]: link, [OTHER]: other };
  const created = createPeerChannel({
    askLink: setup.askLink ?? transmit,
    identity: async () => ({ profileId: ME, displayName: "Me" }),
    authorized: { get: async (id) => peers[id] ?? null },
    link: { get: async (id) => links[id] ?? null },
    log,
    replyTimeoutMs: setup.replyTimeoutMs,
  });
  return { ...created, sent, log };
}

function authorizedPeer(profileId: string): AuthorizedPeer {
  return { profileId, displayName: "Peer", fingerprint: "AB:CD" };
}

const reply = (requestId: string, from = PEER) =>
  JSON.stringify(peerMessage("TABS_SNAPSHOT", { from, to: ME }, { requestId, tabs: [] }));

afterEach(() => {
  vi.useRealTimers();
});

describe("send", () => {
  test("addresses the authorized peer and logs only the type", async () => {
    const { send, sent, log } = channel();
    const message = await send(PEER, "HELLO", { displayName: "Me", extensionVersion: "0.1.0" });
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
    await expect(send(PEER, "GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
    expect(log).not.toHaveBeenCalled();
  });

  test("sends to the named peer only while its link is verified", async () => {
    const { send, sent } = channel({ other: { state: "connecting", verified: false } });
    await expect(send(OTHER, "GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
    await send(PEER, "GET_TABS", {});
    expect(sent.map(({ to }) => to)).toEqual([PEER]);
    const both = channel({ other: UP });
    await both.send(OTHER, "GET_TABS", {});
    expect(both.sent.map(({ to }) => to)).toEqual([OTHER]);
  });
});

describe("request", () => {
  test("resolves with the reply that names it, ignoring others", async () => {
    const { request, receive, sent } = channel();
    const replied = request(PEER, "GET_TABS", {});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const other = await receive(reply("44444444-4444-4444-8444-444444444444"), PEER);
    expect(other.kind).toBe("accepted");
    const answer = reply(sent[0]?.id ?? "");
    await receive(answer, PEER);
    expect(await replied).toEqual(JSON.parse(answer));
  });

  test("fails when no reply comes in time", async () => {
    vi.useFakeTimers();
    const { request } = channel({ replyTimeoutMs: 100 });
    const replied = expect(request(PEER, "GET_TABS", {})).rejects.toThrow(
      "The other profile did not answer in time.",
    );
    await vi.advanceTimersByTimeAsync(100);
    await replied;
  });

  test("waits five seconds by default", async () => {
    vi.useFakeTimers();
    const { request } = channel();
    const settled = vi.fn();
    const replied = request(PEER, "GET_TABS", {}).catch(settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await replied;
    expect(settled).toHaveBeenCalledWith(new Error("The other profile did not answer in time."));
  });

  test("fails at once when the link cannot send", async () => {
    const failing = channel({ askLink: async () => Promise.reject(new Error("closed")) });
    await expect(failing.request(PEER, "GET_TABS", {})).rejects.toThrow("closed");
    const refusing = channel({ askLink: async () => Promise.reject("closed") });
    await expect(refusing.request(PEER, "GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
    const silent = channel({ askLink: async () => ({ sent: false }) });
    await expect(silent.request(PEER, "GET_TABS", {})).rejects.toThrow(NOT_CONNECTED);
  });

  test("fails the waiting requests of a peer whose link drops, and only those", async () => {
    const { request, receive, failPeer, sent } = channel({ other: UP });
    const replies = [request(PEER, "GET_TABS", {}), request(PEER, "SESSION_STOP", {})];
    const kept = request(OTHER, "GET_TABS", {});
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    failPeer(PEER);
    for (const each of replies) await expect(each).rejects.toThrow(NOT_CONNECTED);
    const answer = reply(sent[2]?.id ?? "", OTHER);
    await receive(answer, OTHER);
    expect(await kept).toEqual(JSON.parse(answer));
  });
});

describe("receive", () => {
  test("accepts a message the authorized peer addressed to this profile", async () => {
    const { receive, log } = channel();
    const ask = peerMessage("GET_TABS", { from: PEER, to: ME }, {});
    expect(await receive(JSON.stringify(ask), PEER)).toEqual({ kind: "accepted", message: ask });
    expect(log).toHaveBeenCalledWith("received GET_TABS");
  });

  test("drops a frame that does not parse", async () => {
    const { receive, log } = channel();
    expect(await receive("{", PEER)).toEqual({ kind: "invalid" });
    expect(log).not.toHaveBeenCalled();
  });

  test("drops a frame whose `from` is not the peer of its connection", async () => {
    // Both peers are authorized and linked; OTHER claims PEER's id over its own link.
    const { receive, log } = channel({ other: UP });
    const forged = peerMessage("GET_TABS", { from: PEER, to: ME }, {});
    expect(await receive(JSON.stringify(forged), OTHER)).toEqual({ kind: "unauthorized" });
    const own = peerMessage("GET_TABS", { from: OTHER, to: ME }, {});
    expect(await receive(JSON.stringify(own), OTHER)).toEqual({ kind: "accepted", message: own });
    expect(log).toHaveBeenCalledOnce();
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
    expect(await receive(JSON.stringify(ask), PEER)).toEqual({ kind: "unauthorized" });
    expect(log).not.toHaveBeenCalled();
  });
});
