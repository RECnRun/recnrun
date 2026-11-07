// W7 slice B: pointer events on the live frame become input.v1 events aimed at that frame.
const BUTTONS = ["left", "middle", "right"];
const KEPT = 200;
// Downs and ups come from mouse events: their `detail` is the browser's own click count.
const KINDS = { mousedown: "pointerDown", mouseup: "pointerUp", pointermove: "pointerMove" };

/** The point over the image's content box, as 0..1 of the frame, or null in the letterbox. */
export const imagePoint = (box, natural, client) => {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  const x = (client.x - box.left - (box.width - width) / 2) / width;
  const y = (client.y - box.top - (box.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
};

const modifiersOf = (event) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export const createInteractView = ({ input, visual, observe }) => {
  const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));
  const replies = [];
  const stats = { sent: 0, noFrame: 0, letterbox: 0, coalesced: 0 };
  let attached = null;
  let moving = null;
  let pendingMove = null;
  /** @type {{ width: number, height: number } | null} */
  let natural = null;

  const record = (reply) => {
    replies.push(reply);
    if (replies.length > KEPT) replies.shift();
    return reply;
  };

  /** One event aimed at the frame the image shows now; no frame with geometry, no event. */
  const aim = (name, kind, point, fields = {}) => {
    const frameSeq = visual.shownFrame(name);
    const frame = frameSeq ? input.interactFrame(name, frameSeq) : null;
    if (!frame?.geometry) {
      stats.noFrame += 1;
      return Promise.resolve(null);
    }
    const { bootId, sessionEpoch, loaderId } = frame;
    const target = { bootId, sessionEpoch, frameSeq, loaderId, ...point };
    stats.sent += 1;
    return input.interactEvent(name, kind, { ...target, ...fields }).then(record);
  };

  // Moves are coalesced: one in flight, and only the newest waiting one is sent after it.
  const move = (name, point, fields) => {
    if (moving) {
      if (pendingMove) stats.coalesced += 1;
      pendingMove = { point, fields };
      return;
    }
    moving = aim(name, "pointerMove", point, fields).finally(() => {
      moving = null;
      const next = pendingMove;
      pendingMove = null;
      if (next) move(name, next.point, next.fields);
    });
  };

  const onPointer = (event) => {
    if (!attached || !natural) return;
    const box = image.getBoundingClientRect();
    const point = imagePoint(box, natural, { x: event.clientX, y: event.clientY });
    if (!point) {
      stats.letterbox += 1;
      return;
    }
    const kind = KINDS[event.type];
    const pressed =
      kind === "pointerMove" && event.buttons === 0 ? "none" : (BUTTONS[event.button] ?? "left");
    const fields = { button: pressed, clickCount: 0, modifiers: modifiersOf(event) };
    if (kind === "pointerMove") return move(attached, point, fields);
    event.preventDefault();
    void aim(attached, kind, point, {
      ...fields,
      clickCount: Math.min(Math.max(event.detail, 1), 3),
    });
  };
  for (const type of Object.keys(KINDS)) image.addEventListener(type, onPointer);
  // The size of the last decoded frame: it reads zero while the next frame loads.
  image.addEventListener("load", () => {
    natural = { width: image.naturalWidth, height: image.naturalHeight };
  });
  image.draggable = false;

  /** Observes the accepted lease's tab; frames of it are what the pointer can aim at. */
  const interactObserve = (name) => {
    const { lease } = input.interactSession(name);
    if (!lease?.ok) return Promise.resolve({ ok: false, code: "NO_LEASE" });
    attached = name;
    return observe.observeStart(name, lease.interactId, "live");
  };

  return {
    interactObserve,
    interactAim: aim,
    interactDetach: () => {
      attached = null;
    },
    interactView: () => ({ attached, natural, stats: { ...stats }, replies: [...replies] }),
  };
};
