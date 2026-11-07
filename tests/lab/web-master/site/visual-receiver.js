// W6 slice B: reassembles visual.v1 frames; keeps nothing but the partial and last frame per worker.
const VERSION = 1;
const CODEC_JPEG = 1;
const HEADER_BYTES = 82;

export const LIMITS = {
  messageBytes: 16_384,
  frameBytes: 524_288,
  chunks: 64,
  ttlMs: 2_000,
  workers: 32,
};

const hex = (bytes, offset) =>
  [...bytes.subarray(offset, offset + 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const checkHeader = (head, limits) => {
  if (head.version !== VERSION) return "bad-version";
  if (head.codec !== CODEC_JPEG) return "bad-codec";
  if (head.chunkCount < 1 || head.chunkCount > limits.chunks) return "bad-chunk-count";
  if (head.chunkIndex >= head.chunkCount) return "bad-chunk-index";
  if (head.frameBytes < 1) return "malformed";
  if (head.frameBytes > limits.frameBytes) return "oversize";
  if (head.width < 1 || head.height < 1) return "malformed";
  return null;
};

/** The header and payload of one message, or the reason it is refused. */
export const parse = (data, limits = LIMITS) => {
  if (!(data instanceof ArrayBuffer) || data.byteLength <= HEADER_BYTES) return "malformed";
  if (data.byteLength > limits.messageBytes) return "oversize";
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  const head = {
    version: view.getUint8(0),
    codec: view.getUint8(1),
    workerId: hex(bytes, 2),
    bootId: hex(bytes, 18),
    jobId: hex(bytes, 34),
    targetId: view.getUint32(50),
    epoch: view.getUint32(54),
    frameSeq: view.getUint32(58),
    chunkIndex: view.getUint16(62),
    chunkCount: view.getUint16(64),
    frameBytes: view.getUint32(66),
    width: view.getUint16(70),
    height: view.getUint16(72),
    capturedAtMs: view.getFloat64(74),
  };
  const refused = checkHeader(head, limits);
  if (refused) return refused;
  return { head, payload: bytes.subarray(HEADER_BYTES) };
};

// Every chunk of one frame repeats the same frame fields.
const SAME = ["jobId", "targetId", "epoch", "chunkCount", "frameBytes", "width", "height"];
const matches = (a, b) =>
  SAME.every((key) => a[key] === b[key]) && a.capturedAtMs === b.capturedAtMs;

const isJpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8;

const assemble = (partial) => {
  const bytes = new Uint8Array(partial.head.frameBytes);
  let offset = 0;
  for (const chunk of partial.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/** Where a message of `head` stands against the worker's last frame and partial frame. */
const order = (worker, head) => {
  if (head.bootId !== worker.bootId) {
    // A restarted worker starts over; a late frame of an older boot is still older in time.
    if (head.capturedAtMs < worker.capturedAtMs) return "stale";
    Object.assign(worker, { bootId: head.bootId, epoch: 0, seq: 0, partial: null });
  }
  if (head.epoch < worker.epoch) return "old-epoch";
  if (head.frameSeq <= worker.seq) return "stale";
  return null;
};

export const createReceiver = ({ onFrame, now = Date.now, limits = LIMITS }) => {
  const workers = new Map();
  const drops = {};
  let frames = 0;
  const drop = (reason) => {
    drops[reason] = (drops[reason] ?? 0) + 1;
    return reason;
  };

  const sweep = () => {
    for (const worker of workers.values()) {
      if (worker.partial && now() - worker.partial.startedAt > limits.ttlMs) {
        worker.partial = null;
        drop("expired");
      }
    }
  };

  const workerOf = (head) => {
    const known = workers.get(head.workerId);
    if (known) return known;
    if (workers.size >= limits.workers) return null;
    const worker = { bootId: head.bootId, epoch: 0, seq: 0, capturedAtMs: 0, partial: null };
    workers.set(head.workerId, worker);
    return worker;
  };

  const partialFor = (worker, head) => {
    const current = worker.partial;
    if (current && current.head.frameSeq > head.frameSeq) return "stale";
    if (current && current.head.frameSeq === head.frameSeq) {
      return matches(current.head, head) ? current : "mismatch";
    }
    if (current) drop("superseded");
    worker.partial = { head, chunks: [], received: 0, bytes: 0, startedAt: now() };
    return worker.partial;
  };

  const complete = (worker, partial) => {
    const bytes = assemble(partial);
    worker.partial = null;
    if (partial.bytes !== partial.head.frameBytes) return drop("mismatch");
    if (!isJpeg(bytes)) return drop("not-jpeg");
    const { head } = partial;
    Object.assign(worker, {
      epoch: head.epoch,
      seq: head.frameSeq,
      capturedAtMs: head.capturedAtMs,
    });
    frames += 1;
    onFrame({ ...head, bytes });
    return "frame";
  };

  const add = (worker, head, payload) => {
    const partial = partialFor(worker, head);
    if (typeof partial === "string") return drop(partial);
    if (partial.chunks[head.chunkIndex]) return drop("duplicate");
    if (partial.bytes + payload.length > head.frameBytes) {
      worker.partial = null;
      return drop("overflow");
    }
    partial.chunks[head.chunkIndex] = payload.slice();
    partial.received += 1;
    partial.bytes += payload.length;
    return partial.received === head.chunkCount ? complete(worker, partial) : "partial";
  };

  const accept = (data) => {
    sweep();
    const parsed = parse(data, limits);
    if (typeof parsed === "string") return drop(parsed);
    const worker = workerOf(parsed.head);
    if (!worker) return drop("too-many-workers");
    const refused = order(worker, parsed.head);
    if (refused) return drop(refused);
    return add(worker, parsed.head, parsed.payload);
  };

  return { accept, sweep, stats: () => ({ frames, drops: { ...drops } }) };
};
