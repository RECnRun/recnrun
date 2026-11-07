// W6 slice D: the viewer of one worker, live while open and back to a thumbnail when closed.

const clock = (ms) => new Date(ms).toISOString().slice(11, 23);
const total = (drops) => Object.values(drops ?? {}).reduce((sum, count) => sum + count, 0);

/** The last op the job reached, as text; no click marker: frame and page coordinates differ. */
const traceOf = (ops) => {
  const index = ops.findLastIndex((entry) => entry.state !== "PENDING");
  if (index < 0) return "last action: none yet";
  const entry = ops[index];
  return `last action: op ${index} ${entry.op} ${entry.state}`;
};

export const createViewer = ({ live, back, stop, stateOf, fpsOf, run }) => {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("viewer"));
  const image = /** @type {HTMLImageElement} */ (document.getElementById("viewer-image"));
  const readout = /** @type {HTMLElement} */ (document.getElementById("viewer-readout"));
  const trace = /** @type {HTMLElement} */ (document.getElementById("viewer-trace"));
  /** @type {any} */
  let card = null;
  let url = "";

  // Closing by any means returns the worker to a thumbnail, unless the owner stopped it.
  dialog.addEventListener("close", () => {
    const closed = card;
    card = null;
    if (url) URL.revokeObjectURL(url);
    url = "";
    image.removeAttribute("src");
    if (closed) void run(closed, () => back(closed));
  });
  document.getElementById("viewer-stop")?.addEventListener("click", () => {
    const stopped = card;
    if (stopped) void run(stopped, () => stop(stopped)).then(() => dialog.close());
  });
  document.getElementById("viewer-close")?.addEventListener("click", () => dialog.close());

  const text = () => {
    if (!card?.frame) return "no frame yet";
    const latency = Math.round(card.frame.at - card.frame.capturedAtMs);
    const beat = card.beat ?? {};
    const parts = [
      `frame ${clock(card.frame.capturedAtMs)}`,
      `latency ${latency} ms`,
      `${fpsOf(card)} fps`,
      `drops ${total(beat.drops)}`,
      `capture ${beat.state ?? "unknown"}`,
    ];
    return parts.join(" · ");
  };

  const render = () => {
    if (!card) return;
    readout.textContent = text();
    trace.textContent = traceOf(card.ops);
  };

  return {
    open: async (target) => {
      card = target;
      dialog.showModal();
      await live(target);
      render();
    },
    frame: (target, entry) => {
      if (target !== card) return;
      const previous = url;
      url = URL.createObjectURL(entry.blob);
      image.src = url;
      if (previous) URL.revokeObjectURL(previous);
    },
    render,
    state: () => ({
      open: dialog.open,
      card: card ? stateOf(card) : null,
      readout: readout.textContent,
      trace: trace.textContent,
    }),
  };
};
