// W7 slice D: a press timed on the master's clock, to its reply and to the first painted frame
// whose pixels show its effect. The paint is the next animation frame, a proxy for the display.
const COLOURS = [
  [0xe0, 0x10, 0x10],
  [0x10, 0xc0, 0x10],
  [0x10, 0x10, 0xe0],
  [0xf0, 0xf0, 0x10],
];
const LIMIT_MS = 5_000;
const DOWN = { button: "left", clickCount: 1, modifiers: 0 };

/** The index of the cycle colour nearest `rgb`: JPEG shifts colours, never across the cycle. */
const nearestColour = (rgb) => {
  const away = COLOURS.map((c) => Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]));
  return away.indexOf(Math.min(...away));
};

const pixelOf = async (blob, point) => {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const x = Math.floor(point.x * bitmap.width);
  const y = Math.floor(point.y * bitmap.height);
  const { data } = context.getImageData(x, y, 1, 1);
  return [data[0], data[1], data[2]];
};

export const createLatency = ({ input, visual }) => {
  const watchers = new Set();
  visual.onVisualFrame((name, entry) => {
    for (const watcher of watchers) watcher(name, entry);
  });

  /** Resolves with the paint time of the first frame from now that shows `colour` at `point`. */
  const shows = (name, point, colour) =>
    new Promise((resolve) => {
      const finish = (at) => {
        watchers.delete(watcher);
        resolve(at);
      };
      const watcher = (from, entry) => {
        if (from !== name) return;
        void pixelOf(entry.blob, point).then((rgb) => {
          if (!watchers.has(watcher) || nearestColour(rgb) !== colour) return;
          watchers.delete(watcher);
          requestAnimationFrame(() => finish(performance.now()));
        });
      };
      watchers.add(watcher);
      setTimeout(() => watchers.has(watcher) && finish(null), LIMIT_MS);
    });

  /**
   * One click aimed at the latest screencast frame the worker announced on input.v1, which frames
   * it never announced (a lab burst) do not replace. `colour` null times the reply only.
   */
  const latencyClick = async (name, point, colour) => {
    const frame = input.interactAimable(name);
    if (!frame?.geometry) return { ok: false, code: "NO_FRAME", frame };
    const { bootId, sessionEpoch, frameSeq, loaderId } = frame;
    const fields = { bootId, sessionEpoch, frameSeq, loaderId, ...point, ...DOWN };
    const started = performance.now();
    const visible = colour === null ? Promise.resolve(null) : shows(name, point, colour);
    const down = await input.interactEvent(name, "pointerDown", fields);
    const ackMs = performance.now() - started;
    const up = await input.interactEvent(name, "pointerUp", fields);
    const shownAt = await visible;
    const visibleMs = shownAt === null ? null : shownAt - started;
    return { ok: Boolean(down?.ok && up?.ok), down, up, ackMs, visibleMs };
  };

  return { latencyClick };
};
