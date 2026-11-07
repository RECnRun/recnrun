// W7 slice B: the frames the master may aim at, and their mapping to CSS pixels of the page.
const FRAME_LIMITS = { maxAgeMs: 1_500, size: 128 };
const GEOMETRY = ["deviceWidth", "deviceHeight", "pageScaleFactor", "offsetTop"];
const MOUSE = {
  pointerMove: "mouseMoved",
  pointerDown: "mousePressed",
  pointerUp: "mouseReleased",
};
export const POINTER_KINDS = Object.keys(MOUSE);

/** The screencast metadata a pointer maps through; null for a frame without it (a screenshot). */
export const geometryOf = (metadata) => {
  if (!metadata || !GEOMETRY.every((key) => Number.isFinite(metadata[key]))) return null;
  return Object.fromEntries(GEOMETRY.map((key) => [key, metadata[key]]));
};

const sameGeometry = (a, b) => GEOMETRY.every((key) => a[key] === b[key]);

/**
 * Normalized image coordinates to CSS pixels of the main frame. Screencast sizes are DIP, and
 * Chromium scales dispatched mouse points by zoom × page scale; it adds no scroll offset.
 */
export const toCss = (geometry, x, y, zoom) => {
  const scale = zoom * geometry.pageScaleFactor;
  return {
    x: (x * geometry.deviceWidth) / scale,
    y: (y * geometry.deviceHeight - geometry.offsetTop) / scale,
  };
};

/** The Input.dispatchMouseEvent params of a checked pointer event aimed at `entry`. */
export const mouseParams = (event, entry, zoom) => ({
  type: MOUSE[event.kind],
  ...toCss(entry.geometry, event.x, event.y, zoom),
  button: event.button,
  clickCount: event.clickCount,
  modifiers: event.modifiers,
});

export const createFrames = ({ now = Date.now, limits = FRAME_LIMITS } = {}) => {
  /** @type {Map<number, any>} frameSeq → the frame as sent */
  const entries = new Map();
  /** @type {any} */
  let latest = null;

  /** A screencast frame the master was sent: its seq, boot, session, document, and geometry. */
  const add = (entry) => {
    const kept = { ...entry, sentAt: now() };
    entries.delete(entry.frameSeq);
    entries.set(entry.frameSeq, kept);
    latest = kept;
    if (entries.size > limits.size) entries.delete(entries.keys().next().value);
  };

  /** The refusal of an event aimed at a frame, or null; `live` is the tab's document now. */
  const check = (event, live) => {
    const entry = entries.get(event.frameSeq);
    if (!entry || entry.bootId !== event.bootId || entry.sessionEpoch !== event.sessionEpoch) {
      return "UNKNOWN_FRAME";
    }
    if (entry.loaderId !== event.loaderId || entry.loaderId !== live.loaderId) {
      return "TARGET_CHANGED";
    }
    // Zoom is pinned at 100%: any other value means the page no longer matches the frame.
    if (!sameGeometry(entry.geometry, latest.geometry) || live.zoom !== 1) {
      return "VIEWPORT_CHANGED";
    }
    return now() - entry.sentAt > limits.maxAgeMs ? "STALE_FRAME" : null;
  };

  const clear = () => {
    entries.clear();
    latest = null;
  };

  return {
    add,
    check,
    clear,
    get: (frameSeq) => entries.get(frameSeq),
    latest: () => latest,
    size: () => entries.size,
  };
};
