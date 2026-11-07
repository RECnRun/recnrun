// W6 slice B: the master's side of visual.v1. Shows the last frame per worker; stores nothing.
import { createReceiver } from "./visual-receiver.js";

const SWEEP_MS = 500;
// The a–p extension id the worker's frames carry, as the receiver's hex.
export const hexOfWorker = (id) =>
  [...id].map((letter) => (letter.charCodeAt(0) - 97).toString(16)).join("");
const SAMPLES = 200;

export const createVisual = ({ links, nextMessage }) => {
  const shown = new Map();
  const arrivals = [];
  let revoked = 0;
  /** @type {Blob | null} */
  let lastBlob = null;
  const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));

  // One object URL per worker: the previous frame's URL is revoked before the next is shown.
  const onFrame = (frame) => {
    lastBlob = new Blob([frame.bytes], { type: "image/jpeg" });
    const url = URL.createObjectURL(lastBlob);
    const previous = shown.get(frame.workerId);
    shown.set(frame.workerId, { url, epoch: frame.epoch, frameSeq: frame.frameSeq });
    image.src = url;
    if (previous) {
      URL.revokeObjectURL(previous.url);
      revoked += 1;
    }
    arrivals.push({ frameSeq: frame.frameSeq, at: Date.now() });
    const session = sessions.get(frame.workerId);
    if (session && session.firstFrameMs === null) {
      session.firstFrameMs = performance.now() - session.sentAt;
    }
    if (arrivals.length > SAMPLES) arrivals.shift();
  };
  const receiver = createReceiver({ onFrame });
  setInterval(() => receiver.sweep(), SWEEP_MS);

  const sessions = new Map();
  const plain = (uuid) => uuid.replaceAll("-", "");

  // A frame is shown only on a proven link, for the worker it proved, in the session started.
  const admitOn = (name) => (head) => {
    const proven = links.get(name)?.proven;
    if (!proven) return "unproven";
    if (head.workerId !== hexOfWorker(proven.workerId)) return "wrong-worker";
    const session = sessions.get(head.workerId);
    if (!session) return "unsolicited";
    if (head.bootId !== plain(session.bootId)) return "wrong-boot";
    return head.jobId === plain(session.jobId) ? null : "wrong-job";
  };

  const attach = (channel, name) => {
    channel.binaryType = "arraybuffer";
    const admit = admitOn(name);
    channel.onmessage = ({ data }) => void receiver.accept(data, admit);
  };

  /** A new accepted start: the worker's frame ordering starts over with this boot and job. */
  const beginSession = (workerId, session) => {
    const hex = hexOfWorker(workerId);
    sessions.set(hex, { ...session, sentAt: performance.now(), firstFrameMs: null });
    receiver.reset(hex);
  };
  const endSession = (workerId) => void sessions.delete(hexOfWorker(workerId));

  const control = async (name, message) => {
    const { channel } = links.get(name);
    const reply = nextMessage(channel, `${message.type}-reply`);
    channel.send(JSON.stringify(message));
    return reply;
  };
  // Control traffic during streaming: the same job-status round trip the journal uses.
  const jobStatus = (name, jobIds) => control(name, { type: "job-status", jobIds });

  // Decodes the shown frame's own Blob: the image element may swap src mid-decode.
  const visualPixel = async (fx, fy) => {
    if (!lastBlob) return null;
    const bitmap = await createImageBitmap(lastBlob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const x = Math.floor(fx * bitmap.width);
    const y = Math.floor(fy * bitmap.height);
    const { data } = context.getImageData(x, y, 1, 1);
    return [data[0], data[1], data[2]];
  };

  const visualStats = () => ({
    ...receiver.stats(),
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
  };
};
