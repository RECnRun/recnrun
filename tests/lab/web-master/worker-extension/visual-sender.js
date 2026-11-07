// W6 slice B: the offscreen side of visual.v1. One frame in flight, the latest wins, a bounded buffer.
import { MESSAGE_MAX, encodeFrame } from "./visual-envelope.js";

const BUFFER_CAP = 262_144;
const BUFFER_LOW = 65_536;
const SAMPLES = 200;

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sample = (list, value) => {
  list.push(value);
  if (list.length > SAMPLES) list.shift();
};

export const createSender = () => {
  /**
   * @type {{ channel: RTCDataChannel | null, pc: RTCPeerConnection | null, slot: any,
   *   inflight: boolean, relayed: any }}
   */
  const state = { channel: null, pc: null, slot: null, inflight: false, relayed: null };
  const stats = {
    offered: 0,
    sent: 0,
    messages: 0,
    maxBuffered: 0,
    rejected: 0,
    drops: { replaced: 0, oversize: 0, closed: 0, invalid: 0 },
    relayMs: [],
    handoffs: [],
    base64Ms: [],
    messageMax: 0,
    lastError: "",
  };

  const release = () => {
    state.inflight = false;
    pump();
  };

  // A frame stays in flight until the channel's buffer drains back under the low threshold.
  const send = (channel, frame) => {
    const messageMax = Math.min(MESSAGE_MAX, state.pc?.sctp?.maxMessageSize ?? MESSAGE_MAX);
    stats.messageMax = messageMax;
    const messages = encodeFrame(frame, frame.bytes, messageMax);
    const total = messages.reduce((sum, message) => sum + message.byteLength, 0);
    if (channel.bufferedAmount + total > BUFFER_CAP) {
      stats.drops.oversize += 1;
      return;
    }
    for (const message of messages) channel.send(message);
    stats.sent += 1;
    stats.messages += messages.length;
    stats.maxBuffered = Math.max(stats.maxBuffered, channel.bufferedAmount);
    state.inflight = true;
    if (channel.bufferedAmount <= BUFFER_LOW) setTimeout(release, 0);
  };

  function pump() {
    if (state.inflight || !state.slot) return;
    const frame = state.slot;
    state.slot = null;
    const { channel } = state;
    if (channel?.readyState !== "open") {
      stats.drops.closed += 1;
      return;
    }
    try {
      send(channel, frame);
    } catch (error) {
      stats.drops.invalid += 1;
      stats.lastError = String(error);
    }
  }

  const offer = (frame) => {
    stats.offered += 1;
    if (state.slot) stats.drops.replaced += 1;
    state.slot = frame;
    pump();
  };

  /** A frame from the service worker over chrome.runtime: base64 in, bytes out. */
  const relayed = (message) => {
    sample(stats.relayMs, Date.now() - message.queuedAt);
    sample(stats.handoffs, {
      bootId: message.bootId,
      frameSeq: message.frameSeq,
      at: message.queuedAt,
    });
    const started = performance.now();
    const bytes = fromBase64(message.data);
    sample(stats.base64Ms, performance.now() - started);
    state.relayed = { ...message, workerId: chrome.runtime.id, bytes };
    offer(state.relayed);
  };

  // Lab only: `count` padded copies of the last frame offered within one task, numbered past it,
  // so the buffer cap and the latest-wins slot are seen working.
  const burst = (count, padBytes) => {
    const base = state.relayed;
    if (!base) return { ok: false, error: "NO_FRAME" };
    const before = structuredClone(stats.drops);
    const bytes = new Uint8Array(base.bytes.length + padBytes);
    bytes.set(base.bytes);
    const first = base.frameSeq + 1_000;
    for (let index = 0; index < count; index += 1) {
      offer({ ...base, bytes, frameSeq: first + index, capturedAtMs: Date.now() });
    }
    const buffered = state.channel?.bufferedAmount ?? 0;
    return { ok: true, frameBytes: bytes.length, buffered, before, stats };
  };

  const channels = new Map();

  /** Registers a link's visual.v1; frames go nowhere until an accepted start selects it. */
  const attach = (channel, pc) => {
    channels.set(pc, channel);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.onbufferedamountlow = release;
    // visual.v1 carries frames one way; anything the master sends on it is refused.
    channel.onmessage = () => {
      stats.rejected += 1;
    };
  };

  // Frames go only to the link whose signed start the worker accepted.
  const select = (pc) => {
    Object.assign(state, { channel: channels.get(pc) ?? null, pc, slot: null, inflight: false });
  };

  /** The session ended: the frame waiting to be sent is dropped, not kept for the next one. */
  const clear = () => {
    state.slot = null;
  };

  // The live buffer level, for the W6.E samples of a bounded queue under network faults.
  const current = () => ({ ...stats, buffered: state.channel?.bufferedAmount ?? 0 });
  return { attach, select, clear, relayed, burst, stats: current };
};
