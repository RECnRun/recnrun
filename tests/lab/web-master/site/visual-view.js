// W6 slice B: the master's side of visual.v1. Shows the last frame per worker; stores nothing.
import { createReceiver } from "./visual-receiver.js";

const SWEEP_MS = 500;
// The a–p extension id the worker's frames carry, as the receiver's hex.
export const hexOfWorker = (id) =>
  [...id].map((letter) => (letter.charCodeAt(0) - 97).toString(16)).join("");
const SAMPLES = 200;

const totals = (all) => {
  const drops = {};
  for (const stats of all) {
    for (const [reason, count] of Object.entries(stats.drops)) {
      drops[reason] = (drops[reason] ?? 0) + count;
    }
  }
  return { frames: all.reduce((sum, stats) => sum + stats.frames, 0), drops };
};

export const createVisual = ({ links, nextMessage }) => {
  const shown = new Map();
  const arrivals = [];
  let revoked = 0;
  /** @type {Blob | null} */
  let lastBlob = null;
  // Keyed by link: every root of the same build carries the same extension id.
  const latest = new Map();
  const listeners = new Set();
  const receivers = new Map();
  const sessions = new Map();
  const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));

  // One object URL per link: the previous frame's URL is revoked before the next is shown.
  const onFrame = (name, frame) => {
    lastBlob = new Blob([frame.bytes], { type: "image/jpeg" });
    const entry = { blob: lastBlob, capturedAtMs: frame.capturedAtMs, at: Date.now() };
    latest.set(name, entry);
    for (const listener of listeners) listener(name, entry);
    const url = URL.createObjectURL(lastBlob);
    const previous = shown.get(name);
    shown.set(name, { url, epoch: frame.epoch, frameSeq: frame.frameSeq });
    image.src = url;
    if (previous) {
      URL.revokeObjectURL(previous.url);
      revoked += 1;
    }
    arrivals.push({ frameSeq: frame.frameSeq, at: Date.now() });
    const session = sessions.get(name);
    if (session && session.firstFrameMs === null) {
      session.firstFrameMs = performance.now() - session.sentAt;
    }
    if (arrivals.length > SAMPLES) arrivals.shift();
  };
  setInterval(() => {
    for (const receiver of receivers.values()) receiver.sweep();
  }, SWEEP_MS);

  const plain = (uuid) => uuid.replaceAll("-", "");

  // A frame is shown only on a proven link, for the worker it proved, in the session started.
  const admitOn = (name) => (head) => {
    const proven = links.get(name)?.proven;
    if (!proven) return "unproven";
    if (head.workerId !== hexOfWorker(proven.workerId)) return "wrong-worker";
    const session = sessions.get(name);
    if (!session) return "unsolicited";
    if (head.bootId !== plain(session.bootId)) return "wrong-boot";
    return head.jobId === plain(session.jobId) ? null : "wrong-job";
  };

  const attach = (channel, name) => {
    channel.binaryType = "arraybuffer";
    const admit = admitOn(name);
    const receiver = createReceiver({ onFrame: (frame) => onFrame(name, frame) });
    receivers.set(name, receiver);
    channel.onmessage = ({ data }) => void receiver.accept(data, admit);
  };

  /** A new accepted start: the link's frame ordering starts over with this boot and job. */
  const beginSession = (name, session) => {
    sessions.set(name, { ...session, sentAt: performance.now(), firstFrameMs: null });
    const workerId = links.get(name)?.proven?.workerId;
    if (workerId) receivers.get(name)?.reset(hexOfWorker(workerId));
  };
  const endSession = (name) => void sessions.delete(name);

  const control = async (name, message) => {
    const { channel } = links.get(name);
    const reply = nextMessage(channel, `${message.type}-reply`);
    channel.send(JSON.stringify(message));
    return reply;
  };
  // Control traffic during streaming: the same job-status round trip the journal uses.
  const jobStatus = (name, jobIds) => control(name, { type: "job-status", jobIds });

  // Decodes the shown frame's own Blob: the image element may swap src mid-decode.
  const visualPixel = async (fx, fy, name) => {
    const blob = name ? latest.get(name)?.blob : lastBlob;
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const x = Math.floor(fx * bitmap.width);
    const y = Math.floor(fy * bitmap.height);
    const { data } = context.getImageData(x, y, 1, 1);
    return [data[0], data[1], data[2]];
  };

  const visualStats = () => ({
    ...totals([...receivers.values()].map((receiver) => receiver.stats())),
    workers: [...shown.values()],
    sessions: [...sessions.values()],
    revoked,
    arrivals: [...arrivals],
    size: [image.naturalWidth, image.naturalHeight],
  });

  /** Sends raw text on visual.v1, which the worker must not answer or act on. */
  const visualSendRaw = (name, text) => links.get(name).visual.send(text);

  return {
    attach,
    beginSession,
    endSession,
    visualPixel,
    visualStats,
    visualSendRaw,
    jobStatus,
    onVisualFrame: (listener) => void listeners.add(listener),
  };
};
