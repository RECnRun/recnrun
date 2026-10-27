import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { linkCommandMessage } from "@/messaging/peer-messages";
import type { LinkCommand } from "@/messaging/peer-messages";
import { startOffscreen } from "@/offscreen/start";
import { ME, PEER, answering } from "./fake-peer";
import { MemoryDirectory } from "./memory-directory";

const LOCAL_SDP = "v=0\r\na=fingerprint:sha-256 11:22\r\n";
const REMOTE_SDP = "v=0\r\na=fingerprint:sha-256 aa:bb\r\n";
const certificate = {
  expires: Number.MAX_SAFE_INTEGER,
  getFingerprints: () => [
    { algorithm: "sha-1", value: "00:00" },
    { algorithm: "sha-256", value: "ab:cd" },
  ],
} as unknown as RTCCertificate;

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  readonly sent: string[] = [];
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
}

/** Just what the link calls of an RTCPeerConnection, gathering at once; Node has no WebRTC. */
class FakeConnection extends EventTarget {
  static made: FakeConnection[] = [];
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: { sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  channel: FakeChannel | undefined;
  readonly config: RTCConfiguration;
  constructor(config: RTCConfiguration) {
    super();
    this.config = config;
    FakeConnection.made.push(this);
  }
  createDataChannel() {
    this.channel = new FakeChannel();
    return this.channel;
  }
  async setLocalDescription() {
    this.signalingState = this.remoteDescription ? "stable" : "have-local-offer";
    this.localDescription = { sdp: LOCAL_SDP };
    this.iceGatheringState = "complete";
  }
  async setRemoteDescription({ sdp }: { sdp: string }) {
    this.remoteDescription = { sdp };
  }
  close() {}
  /** The other side's channel arriving, as the answering side receives it. */
  receiveChannel() {
    this.channel = new FakeChannel();
    this.dispatchEvent(Object.assign(new Event("datachannel"), { channel: this.channel }));
    return this.channel;
  }
}

const background = () => ({
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL("/background.js"),
});

/** The offscreen document, through the default sender, its events to the background recorded. */
function offscreen(
  cert: () => Promise<RTCCertificate> = async () => certificate,
  chosen?: MemoryDirectory,
) {
  const events: unknown[] = [];
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
    answering((message) => void events.push((message as { event: unknown }).event)),
  );
  const folder = async () => chosen as unknown as FileSystemDirectoryHandle | undefined;
  startOffscreen({ certificate: cert, folder });
  return { events };
}

async function run(command: LinkCommand, sender: object = background()) {
  const reply = vi.fn();
  const [answered] = await fakeBrowser.runtime.onMessage.trigger(
    linkCommandMessage(command),
    sender,
    reply,
  );
  expect(answered).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce(), { interval: 1 });
  return reply.mock.calls[0]?.[0] as unknown;
}

const state = (name: string, remoteFingerprint?: string) => ({
  type: "state",
  state: name,
  ...(remoteFingerprint ? { remoteFingerprint } : {}),
});

beforeEach(() => {
  fakeBrowser.reset();
  FakeConnection.made = [];
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("commands", () => {
  test("ignores anything but a valid command from the service worker", async () => {
    offscreen();
    const reply = vi.fn();
    const from = background();
    const ignored: [unknown, object][] = [
      [linkCommandMessage({ type: "close" }), { ...from, id: "another-extension" }],
      [
        linkCommandMessage({ type: "close" }),
        { ...from, url: fakeBrowser.runtime.getURL("/dashboard.html") },
      ],
      [{ target: "offscreen", command: { type: "erase" } }, from],
      [{ type: "peer-changed" }, from],
    ];
    for (const [message, sender] of ignored) {
      expect(await fakeBrowser.runtime.onMessage.trigger(message, sender, reply)).toEqual([false]);
    }
    expect(reply).not.toHaveBeenCalled();
  });

  test("sends nothing before a link opens", async () => {
    offscreen();
    expect(await run({ type: "send", frame: "{}" })).toEqual({ ok: true, result: { sent: false } });
  });

  test("replies with the error of a command that fails, and reports the failed link", async () => {
    const { events } = offscreen();
    expect(await run({ type: "accept-answer", sdp: REMOTE_SDP })).toEqual({
      ok: false,
      error: "Create an offer first.",
    });
    expect(events).toStrictEqual([state("failed")]);
  });

  test("answers every command with the error when the certificate cannot load", async () => {
    offscreen(async () => {
      throw new Error("IndexedDB is unavailable.");
    });
    expect(await run({ type: "close" })).toEqual({ ok: false, error: "IndexedDB is unavailable." });
  });
});

describe("the folder", () => {
  test.each([
    ["none", undefined],
    ["prompt", Object.assign(new MemoryDirectory(), { permission: "prompt" as const })],
  ])("tells whether a folder is chosen and may be edited: %s", async (access, chosen) => {
    offscreen(undefined, chosen);
    expect(await run({ type: "folder-status" })).toEqual({ ok: true, result: { access } });
  });

  test("waits in the folder with the certificate's fingerprint, publishes, and stops", async () => {
    const chosen = new MemoryDirectory();
    const { events } = offscreen(undefined, chosen);
    const own = () => [...chosen.folder("pairing", ME).files.keys()];
    expect(await run({ type: "folder-watch", profileId: ME, displayName: "Laptop" })).toEqual({
      ok: true,
    });
    expect(events).toEqual([{ type: "folder", presences: [], signals: [] }]);
    expect(JSON.parse(chosen.folder("pairing", ME).files.get("presence.json") ?? "")).toEqual({
      profileId: ME,
      displayName: "Laptop",
      fingerprint: "AB:CD",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
    });
    const signal = {
      kind: "offer" as const,
      pairingId: "44444444-4444-4444-8444-444444444444",
      profileId: ME,
      to: PEER,
      expiresAt: Date.now() + 60_000,
      code: "RECNRUN-PAIR-1.code",
    };
    await run({ type: "folder-publish", signal });
    expect(own()).toHaveLength(2);
    await run({ type: "folder-stop" });
    expect(own()).toEqual([]);
  });
});

describe("the link", () => {
  test("offers, takes the answer, and carries frames both ways", async () => {
    const { events } = offscreen();
    expect(await run({ type: "offer" })).toEqual({ ok: true, result: { sdp: LOCAL_SDP } });
    const [pc] = FakeConnection.made;
    expect(pc?.config).toEqual({ iceServers: [], certificates: [certificate] });
    expect(await run({ type: "accept-answer", sdp: REMOTE_SDP })).toEqual({ ok: true });
    pc?.channel?.open();
    expect(await run({ type: "send", frame: "to peer" })).toEqual({
      ok: true,
      result: { sent: true },
    });
    expect(pc?.channel?.sent).toEqual(["to peer"]);
    pc?.channel?.dispatchEvent(new MessageEvent("message", { data: "from peer" }));
    expect(await run({ type: "close" })).toEqual({ ok: true });
    expect(events).toStrictEqual([
      state("connecting"),
      state("connected", "AA:BB"),
      { type: "frame", frame: "from peer" },
      state("disconnected", "AA:BB"),
    ]);
  });

  test("answers an offer and reports the channel the offer opened", async () => {
    const { events } = offscreen();
    expect(await run({ type: "answer", sdp: REMOTE_SDP })).toEqual({
      ok: true,
      result: { sdp: LOCAL_SDP },
    });
    FakeConnection.made[0]?.receiveChannel().open();
    expect(events).toStrictEqual([state("connecting"), state("connected", "AA:BB")]);
  });

  test("keeps working when the service worker is not there to hear a report", async () => {
    // A plain function, since a spy handles the promises its mock returns.
    const events: unknown[] = [];
    let reachable = false;
    const send = async (message: unknown) => {
      if (!reachable) throw new Error("Receiving end does not exist.");
      events.push((message as { event: unknown }).event);
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    startOffscreen({ send, certificate: async () => certificate });
    expect(await run({ type: "offer" })).toEqual({ ok: true, result: { sdp: LOCAL_SDP } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    reachable = true;
    FakeConnection.made[0]?.channel?.open();
    expect(events).toStrictEqual([state("connected")]);
  });
});
