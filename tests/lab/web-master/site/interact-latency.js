// W7 slice D: a press timed on the master's clock, to its reply and to the presentation of the
// first frame that draws its id. Presented is the animation frame after decode, the paint proxy.
const LIMIT_MS = 5_000;
const DOWN = { button: "left", clickCount: 1, modifiers: 0 };

/** The id the page drew in its cells, one bit per cell, white for 1; JPEG keeps black and white. */
const idOf = async (blob, cells) => {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  let id = 0;
  cells.forEach((cell, bit) => {
    const x = Math.floor(cell.x * bitmap.width);
    const y = Math.floor(cell.y * bitmap.height);
    const { data } = context.getImageData(x, y, 1, 1);
    if ((data[0] + data[1] + data[2]) / 3 > 128) id |= 1 << bit;
  });
  return id;
};

export const createLatency = ({ input, visual }) => {
  const watchers = new Set();
  visual.onPresented((name, entry, at) => {
    for (const watcher of watchers) watcher(name, entry, at);
  });

  /** Resolves with the presentation time of the first presented frame that draws `id`. */
  const shows = (name, { id, cells }) =>
    new Promise((resolve) => {
      const finish = (at) => {
        watchers.delete(watcher);
        resolve(at);
      };
      const watcher = (from, entry, at) => {
        if (from !== name) return;
        void idOf(entry.blob, cells).then((shown) => {
          if (watchers.has(watcher) && shown === id % 256) finish(at);
        });
      };
      watchers.add(watcher);
      setTimeout(() => watchers.has(watcher) && finish(null), LIMIT_MS);
    });

  /**
   * One click aimed at the latest screencast frame the worker announced on input.v1, which frames
   * it never announced (a lab burst) do not replace. `mark` null times the reply only.
   */
  const latencyClick = async (name, point, mark) => {
    const frame = input.interactAimable(name);
    if (!frame?.geometry) return { ok: false, code: "NO_FRAME", frame };
    const { bootId, sessionEpoch, frameSeq, loaderId } = frame;
    const fields = { bootId, sessionEpoch, frameSeq, loaderId, ...point, ...DOWN };
    const started = performance.now();
    const visible = mark === null ? Promise.resolve(null) : shows(name, mark);
    const down = await input.interactEvent(name, "pointerDown", fields);
    const ackMs = performance.now() - started;
    const up = await input.interactEvent(name, "pointerUp", fields);
    const shownAt = await visible;
    const visibleMs = shownAt === null ? null : shownAt - started;
    return { ok: Boolean(down?.ok && up?.ok), down, up, ackMs, visibleMs };
  };

  return { latencyClick };
};
