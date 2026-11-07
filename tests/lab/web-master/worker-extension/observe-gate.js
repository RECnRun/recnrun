// W6 slice C: caps of the worker's own that no request can raise: size, fps, bytes per second.
// 190 KiB plus 12 chunk headers fits the sender's 256 KiB buffer above its 64 KiB low mark.
export const CAPS = {
  thumbnail: { fps: 1, maxWidth: 480, maxHeight: 270 },
  live: { fps: 5, maxWidth: 960, maxHeight: 540 },
  // W7: worker-local, only for an interaction's own tab; the byte cap still holds.
  interact: { fps: 25, maxWidth: 960, maxHeight: 540 },
  bytesPerSecond: 1_048_576,
  frameBytes: 194_560,
};
const WINDOW_MS = 1_000;

export const createGate = ({ send, now = Date.now, caps = CAPS, valid = () => true }) => {
  /** @type {{ mode: string | null, pending: any, timer: any, lastSentAt: number, sentLog: any[] }} */
  const state = { mode: null, pending: null, timer: null, lastSentAt: -Infinity, sentLog: [] };
  const stats = { sent: 0, bytes: 0, drops: { replaced: 0, dimensions: 0, "frame-cap": 0 } };
  const drop = (reason) => {
    stats.drops[reason] = (stats.drops[reason] ?? 0) + 1;
  };

  // Milliseconds until the pending frame fits both the mode's interval and the byte budget.
  const waitFor = (frame) => {
    const at = now();
    while (state.sentLog.length > 0 && state.sentLog[0].at <= at - WINDOW_MS) state.sentLog.shift();
    const interval = state.lastSentAt + 1_000 / caps[state.mode].fps - at;
    let used = state.sentLog.reduce((sum, entry) => sum + entry.bytes, 0);
    let budget = 0;
    for (const entry of state.sentLog) {
      if (used + frame.bytes.length <= caps.bytesPerSecond) break;
      used -= entry.bytes;
      budget = entry.at + WINDOW_MS - at;
    }
    return Math.max(interval, budget, 0);
  };

  function flush() {
    state.timer = null;
    const frame = state.pending;
    if (!frame || !state.mode) return;
    // The session, target, and document are rechecked at send, not only when the frame arrived.
    if (!valid(frame)) {
      state.pending = null;
      return drop("invalid");
    }
    const wait = waitFor(frame);
    if (wait > 0) {
      state.timer = setTimeout(flush, wait);
      return;
    }
    state.pending = null;
    state.lastSentAt = now();
    state.sentLog.push({ at: state.lastSentAt, bytes: frame.bytes.length });
    stats.sent += 1;
    stats.bytes += frame.bytes.length;
    send(frame);
  }

  const capError = (frame) => {
    const cap = caps[state.mode];
    if (frame.width > cap.maxWidth || frame.height > cap.maxHeight) return "dimensions";
    return frame.bytes.length > caps.frameBytes ? "frame-cap" : null;
  };

  const clear = () => {
    clearTimeout(state.timer);
    state.timer = null;
    state.pending = null;
  };

  const offer = (frame) => {
    if (!state.mode) return;
    const error = capError(frame);
    if (error) return drop(error);
    if (state.pending) drop("replaced");
    state.pending = frame;
    if (!state.timer) flush();
  };

  /** A new mode applies at once, to the held frame too; no mode frees the frame and its timer. */
  const setMode = (mode) => {
    state.mode = mode;
    if (!mode) return clear();
    const error = state.pending && capError(state.pending);
    if (!error) return;
    clear();
    drop(error);
  };

  return { offer, setMode, clear, stats: () => ({ ...stats, pending: state.pending !== null }) };
};
