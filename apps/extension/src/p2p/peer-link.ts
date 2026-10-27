import { fingerprintOf } from "@/p2p/pairing-code";

type LinkState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

export interface PeerLinkEvents {
  onFrame: (frame: string) => void;
  onState: (state: LinkState) => void;
}

/** One RTCPeerConnection and its DataChannel; each pairing replaces the previous connection. */
export interface PeerLink {
  /** The complete offer SDP, once ICE gathering ended (no trickle ICE). */
  createOffer: () => Promise<string>;
  /** Answers an offer with the complete answer SDP. */
  acceptOffer: (offerSdp: string) => Promise<string>;
  acceptAnswer: (answerSdp: string) => Promise<void>;
  send: (frame: string) => boolean;
  close: () => void;
  state: () => LinkState;
  remoteFingerprint: () => string | undefined;
}

interface LinkOptions {
  certificate?: RTCCertificate;
  /** Host candidates gather in milliseconds; this bounds a stalled gathering. */
  gatherTimeoutMs?: number;
}

function gathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const check = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", check);
    check();
  });
}

/** The link's state, reported once per change. */
function createTracker(events: PeerLinkEvents) {
  let current: LinkState = "idle";
  const set = (next: LinkState) => {
    if (next === current) return;
    current = next;
    events.onState(next);
  };
  return { set, state: () => current };
}

type Tracker = ReturnType<typeof createTracker>;

function watchConnection(pc: RTCPeerConnection, tracker: Tracker, isCurrent: () => boolean) {
  pc.addEventListener("connectionstatechange", () => {
    const { connectionState } = pc;
    if (!isCurrent()) return;
    if (connectionState === "failed" || connectionState === "disconnected")
      tracker.set(connectionState);
  });
}

async function exportLocal(pc: RTCPeerConnection, timeoutMs: number): Promise<string> {
  await pc.setLocalDescription();
  await gathered(pc, timeoutMs);
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("No local description.");
  return sdp;
}

/** The current connection and its channel; a fresh one closes the previous. */
function createSlot(tracker: Tracker, events: PeerLinkEvents, certificate?: RTCCertificate) {
  let pc: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  const adopt = (opened: RTCDataChannel) => {
    channel = opened;
    opened.addEventListener("open", () => tracker.set("connected"));
    opened.addEventListener("close", () => {
      if (channel === opened) tracker.set("disconnected");
    });
    opened.addEventListener("message", ({ data }) => {
      if (typeof data === "string") events.onFrame(data);
    });
  };
  const fresh = () => {
    pc?.close();
    // No STUN or TURN server: only this machine's host candidates.
    const next = new RTCPeerConnection({
      iceServers: [],
      certificates: certificate && [certificate],
    });
    pc = next;
    channel = undefined;
    watchConnection(next, tracker, () => pc === next);
    next.addEventListener("datachannel", ({ channel: opened }) => adopt(opened));
    tracker.set("connecting");
    return next;
  };
  const close = () => {
    channel?.close();
    channel = undefined;
    pc?.close();
  };
  return { adopt, fresh, close, pc: () => pc, channel: () => channel };
}

export function createPeerLink(events: PeerLinkEvents, options: LinkOptions = {}): PeerLink {
  const { certificate, gatherTimeoutMs = 10_000 } = options;
  const tracker = createTracker(events);
  const slot = createSlot(tracker, events, certificate);
  const guarded = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      tracker.set("failed");
      throw error;
    });
  return {
    createOffer: () =>
      guarded(() => {
        const pc = slot.fresh();
        slot.adopt(pc.createDataChannel("recnrun", { ordered: true }));
        return exportLocal(pc, gatherTimeoutMs);
      }),
    acceptOffer: (offerSdp) =>
      guarded(async () => {
        const pc = slot.fresh();
        await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
        return exportLocal(pc, gatherTimeoutMs);
      }),
    acceptAnswer: (answerSdp) =>
      guarded(async () => {
        const pc = slot.pc();
        if (pc?.signalingState !== "have-local-offer") throw new Error("Create an offer first.");
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      }),
    send: (frame) => {
      const channel = slot.channel();
      if (channel?.readyState !== "open") return false;
      channel.send(frame);
      return true;
    },
    close: () => {
      slot.close();
      if (tracker.state() !== "idle") tracker.set("disconnected");
    },
    state: tracker.state,
    remoteFingerprint: () => fingerprintOf(slot.pc()?.remoteDescription?.sdp ?? ""),
  };
}
