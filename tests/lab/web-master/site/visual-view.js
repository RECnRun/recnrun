// W6 slice B: the master's side of visual.v1. Shows the last frame per worker; stores nothing.
import { createAdmission } from "./admission.js";
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
  // Told of each frame at its presentation, with that frame's own Blob and the paint time.
  const presentedListeners = new Set();
  const receivers = new Map();
  // Request-to-first-frame timing per link, for the lab's measurements.
  const sessions = new Map();
  const admission = createAdmission();
  const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));

  let supersededCount = 0;
  const superseded = () => {
    supersededCount += 1;
  };
  // Shown means decoded and then painted at the next animation frame; a hidden tab paints nothing.
  const presented = async () => {
    await image.decode();
    if (document.hidden) return { at: Date.now(), painted: false };
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        resolve({ at: Date.now(), now: performance.now(), painted: true }),
      );
    });
  };

  // One object URL per link: the previous frame's URL is revoked before the next is shown.
  const display = (name, frame) => {
    lastBlob = new Blob([frame.bytes], { type: "image/jpeg" });
    const entry = { blob: lastBlob, capturedAtMs: frame.capturedAtMs, at: Date.now() };
    latest.set(name, entry);
    for (const listener of listeners) listener(name, entry);
    const url = URL.createObjectURL(lastBlob);
    const previous = shown.get(name);
    // Events aim at the frame on screen: the new one counts once it is presented, not on arrival.
    const current = { url, epoch: frame.epoch, frameSeq: previous?.frameSeq ?? null };
    shown.set(name, current);
    image.src = url;
    if (previous) {
      URL.revokeObjectURL(previous.url);
      revoked += 1;
    }
    const arrival = { frameSeq: frame.frameSeq, at: Date.now(), capturedAtMs: frame.capturedAtMs };
    arrival.presentedAt = null;
    arrivals.push(arrival);
    if (arrivals.length > SAMPLES) arrivals.shift();
    const session = sessions.get(name);
    presented().then(({ at, now, painted }) => {
      if (painted && shown.get(name) === current) current.frameSeq = frame.frameSeq;
      if (painted) arrival.presentedAt = at;
      if (painted) for (const listener of presentedListeners) listener(name, entry, now);
      if (session && session.firstFrameMs === null) {
        Object.assign(session, { firstFrameMs: performance.now() - session.sentAt, painted });
      }
    }, superseded);
  };
  setInterval(() => {
    for (const receiver of receivers.values()) receiver.sweep();
  }, SWEEP_MS);

  // A frame is shown only on a proven link, for the worker it proved, in a session it accepted.
  const admitOn = (name) => (head) => {
    const proven = links.get(name)?.proven;
    if (!proven) return "unproven";
    if (head.workerId !== hexOfWorker(proven.workerId)) return "wrong-worker";
    return admission.check(name, head);
  };

  const attach = (channel, name) => {
    channel.binaryType = "arraybuffer";
    const admit = admitOn(name);
    const show = (frame) => display(name, frame);
    const receiver = createReceiver({ onFrame: (frame) => admission.offer(name, frame, show) });
    receivers.set(name, receiver);
    channel.onmessage = ({ data }) => void receiver.accept(data, admit);
  };

  /** A start sent: the link's frame ordering starts over; frames wait for the worker's accept. */
  const beginSession = (name, session) => {
    admission.request(name, session);
    sessions.set(name, { ...session, sentAt: performance.now(), firstFrameMs: null });
    const workerId = links.get(name)?.proven?.workerId;
    if (workerId) receivers.get(name)?.reset(hexOfWorker(workerId));
  };
  const acceptSession = (name) => admission.accept(name, (frame) => display(name, frame));
  const endSession = (name, reason = "ended") => {
    admission.revoke(name, reason);
    sessions.delete(name);
  };

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
    admission: admission.stats(),
    revoked,
    superseded: supersededCount,
    arrivals: [...arrivals],
    size: [image.naturalWidth, image.naturalHeight],
  });

  /** Sends raw text on visual.v1, which the worker must not answer or act on. */
  const visualSendRaw = (name, text) => links.get(name).visual.send(text);

  return {
    attach,
    beginSession,
    acceptSession,
    renewed: (name) => admission.renewed(name),
    endSession,
    visualPixel,
    visualStats,
    visualSendRaw,
    jobStatus,
    // The frame the image presents now, so a pointer names the frame it was aimed at.
    shownFrame: (name) => shown.get(name)?.frameSeq ?? null,
    onVisualFrame: (listener) => void listeners.add(listener),
    onPresented: (listener) => void presentedListeners.add(listener),
  };
};
