import { fingerprintOf } from "@/p2p/pairing-code";

export type LinkState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

export interface PeerLinkEvents {
  onFrame: (frame: string) => void;
  onState: (state: LinkState) => void;
}

/** One RTCPeerConnection and its DataChannel; a new pairing replaces the previous connection. */
export interface PeerLink {
  /** The full offer SDP, once every ICE candidate is in it (no trickle ICE). */
  createOffer: () => Promise<string>;
  /** Answers an offer; resolves with the full answer SDP. */
  acceptOffer: (offerSdp: string) => Promise<string>;
  acceptAnswer: (answerSdp: string) => Promise<void>;
  send: (frame: string) => boolean;
  close: () => void;
  state: () => LinkState;
  localFingerprint: () => string | undefined;
  remoteFingerprint: () => string | undefined;
  /** Candidate types and state changes, never addresses or payloads. */
  diagnostics: () => string[];
}

interface LinkOptions {
  certificate?: RTCCertificate;
  /** Gathering normally ends in milliseconds with host candidates only; this bounds a stall. */
  gatherTimeoutMs?: number;
}

/** "host (mDNS) udp" or "srflx udp": what a candidate is, without its address. */
export function describeCandidate(candidate: string): string {
  const type = / typ (\w+)/.exec(candidate)?.[1] ?? "unknown";
  const protocol = candidate.split(" ")[2]?.toLowerCase() ?? "?";
  const mdns = /\s[\w-]+\.local\s/.test(candidate) ? " (mDNS)" : "";
  return `${type}${mdns} ${protocol}`;
}

function gathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The link's state and its bounded diagnostics log. */
function createTracker(events: PeerLinkEvents) {
  const log: string[] = [];
  const started = Date.now();
  let current: LinkState = "idle";
  const note = (entry: string) => {
    log.push(`+${Date.now() - started}ms ${entry}`);
    if (log.length > 200) log.shift();
  };
  const set = (next: LinkState) => {
    if (next === current) return;
    current = next;
    note(`link ${next}`);
    events.onState(next);
  };
  return { log, note, set, state: () => current };
}

type Tracker = ReturnType<typeof createTracker>;

function watchChannel(channel: RTCDataChannel, tracker: Tracker, events: PeerLinkEvents) {
  channel.addEventListener("open", () => tracker.set("connected"));
  channel.addEventListener("close", () => tracker.set("disconnected"));
  channel.addEventListener("message", ({ data }) => {
    if (typeof data === "string") events.onFrame(data);
  });
}

function watchConnection(pc: RTCPeerConnection, tracker: Tracker, isCurrent: () => boolean) {
  pc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate?.candidate) tracker.note(`candidate ${describeCandidate(candidate.candidate)}`);
  });
  pc.addEventListener("iceconnectionstatechange", () => {
    tracker.note(`ice ${pc.iceConnectionState}`);
  });
  pc.addEventListener("connectionstatechange", () => {
    tracker.note(`connection ${pc.connectionState}`);
    if (!isCurrent()) return;
    if (pc.connectionState === "failed") tracker.set("failed");
    if (pc.connectionState === "disconnected") tracker.set("disconnected");
  });
}

async function exportLocal(pc: RTCPeerConnection, timeoutMs: number): Promise<string> {
  await pc.setLocalDescription();
  await gathered(pc, timeoutMs);
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("No local description.");
  return sdp;
}

/** The current connection and its channel; each pairing starts a fresh one. */
function createSlot(tracker: Tracker, events: PeerLinkEvents, certificate?: RTCCertificate) {
  let pc: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  const adopt = (opened: RTCDataChannel) => {
    channel = opened;
    watchChannel(opened, tracker, events);
  };
  const fresh = () => {
    pc?.close();
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
    pc?.close();
    pc = undefined;
  };
  return { adopt, fresh, close, pc: () => pc, channel: () => channel };
}

function guarded<T>(tracker: Tracker, work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    tracker.note(`error ${error instanceof Error ? error.name : "unknown"}`);
    tracker.set("failed");
    throw error;
  });
}

export function createPeerLink(events: PeerLinkEvents, options: LinkOptions = {}): PeerLink {
  const { certificate, gatherTimeoutMs = 10_000 } = options;
  const tracker = createTracker(events);
  const slot = createSlot(tracker, events, certificate);
  return {
    createOffer: () =>
      guarded(tracker, () => {
        const target = slot.fresh();
        slot.adopt(target.createDataChannel("recnrun", { ordered: true }));
        return exportLocal(target, gatherTimeoutMs);
      }),
    acceptOffer: (offerSdp) =>
      guarded(tracker, async () => {
        const target = slot.fresh();
        await target.setRemoteDescription({ type: "offer", sdp: offerSdp });
        return exportLocal(target, gatherTimeoutMs);
      }),
    acceptAnswer: (answerSdp) =>
      guarded(tracker, async () => {
        const pc = slot.pc();
        if (!pc) throw new Error("Create an offer first.");
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
    localFingerprint: () => fingerprintOf(slot.pc()?.localDescription?.sdp ?? ""),
    remoteFingerprint: () => fingerprintOf(slot.pc()?.remoteDescription?.sdp ?? ""),
    diagnostics: () => [...tracker.log],
  };
}
