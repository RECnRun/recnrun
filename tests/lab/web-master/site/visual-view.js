// W6 slice B: the master's side of visual.v1. Shows the last frame per worker; stores nothing.
import { createReceiver } from "./visual-receiver.js";

const SWEEP_MS = 500;
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
    if (arrivals.length > SAMPLES) arrivals.shift();
  };
  const receiver = createReceiver({ onFrame });
  setInterval(() => receiver.sweep(), SWEEP_MS);

  const attach = (channel) => {
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => void receiver.accept(data);
  };

  // lab: replaced by OBSERVE_START in slice C.
  const control = async (name, message) => {
    const { channel } = links.get(name);
    const reply = nextMessage(channel, `${message.type}-reply`);
    channel.send(JSON.stringify(message));
    return reply;
  };
  const visualStart = (name, mode) => control(name, { type: "visual-start", mode });
  const visualStop = (name) => control(name, { type: "visual-stop" });
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
    revoked,
    arrivals: [...arrivals],
    size: [image.naturalWidth, image.naturalHeight],
  });

  /** Sends raw text on visual.v1, which the worker must not answer or act on. */
  const visualSendRaw = (name, text) => links.get(name).visual.send(text);

  return { attach, visualStart, visualStop, visualPixel, visualStats, visualSendRaw, jobStatus };
};
