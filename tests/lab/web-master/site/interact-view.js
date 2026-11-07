// W7 slices B and C: pointer, wheel, and keyboard input on the live frame become input.v1 events.
import { createHold } from "./interact-hold.js";

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

// The worker's closed key table; any other printable key reaches it as text, from beforeinput.
const TABLE_KEYS = ["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowUp"];
TABLE_KEYS.push("ArrowRight", "ArrowDown");
const MAX_DELTA = 10_000;
const LINE_PX = 40;
const clampDelta = (delta) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));

/** One in flight, and only the newest waiting item (merged with the one it replaces) after it. */
const coalescer = (send, merge, stats) => {
  let inFlight = null;
  let waiting = null;
  const push = (item) => {
    if (inFlight) {
      if (waiting) stats.coalesced += 1;
      waiting = waiting ? merge(waiting, item) : item;
      return;
    }
    inFlight = send(item).finally(() => {
      inFlight = null;
      const next = waiting;
      waiting = null;
      if (next) push(next);
    });
  };
  return push;
};

const sumWheel = (older, newer) => ({
  ...newer,
  fields: {
    ...newer.fields,
    deltaX: clampDelta(older.fields.deltaX + newer.fields.deltaX),
    deltaY: clampDelta(older.fields.deltaY + newer.fields.deltaY),
  },
});

// A field off to the side takes the owner's keys; nothing typed stays in it.
const keyCapture = () => {
  const capture = document.createElement("textarea");
  capture.id = "interact-keys";
  capture.setAttribute("aria-label", "Keyboard input for the worker's tab");
  capture.autocomplete = "off";
  const style = { position: "fixed", left: "0", bottom: "0", width: "1px", height: "1px" };
  Object.assign(capture.style, style, { opacity: "0" });
  document.body.append(capture);
  return capture;
};

/** The point and deltas of a wheel over the image, or null in the letterbox. */
const wheelOf = (event, image, natural) => {
  const client = { x: event.clientX, y: event.clientY };
  const point = imagePoint(image.getBoundingClientRect(), natural, client);
  if (!point) return null;
  const scale = event.deltaMode === 1 ? LINE_PX : 1;
  const deltaX = clampDelta(event.deltaX * scale);
  const deltaY = clampDelta(event.deltaY * scale);
  return { point, fields: { deltaX, deltaY, modifiers: modifiersOf(event) } };
};

/** Table keys become key events and inserted characters text events; `send(kind, fields)`. */
const listenKeys = (capture, send, hold) => {
  const onKey = (event) => {
    if (!TABLE_KEYS.includes(event.key)) return;
    event.preventDefault();
    const phase = event.type === "keydown" ? "down" : "up";
    hold.key(event.key, phase === "down");
    void send("key", { code: event.key, phase, modifiers: modifiersOf(event) });
  };
  capture.addEventListener("keydown", onKey);
  capture.addEventListener("keyup", onKey);
  capture.addEventListener("beforeinput", (event) => {
    event.preventDefault();
    if (event.inputType === "insertText" && event.data) void send("text", { text: event.data });
  });
  // An input that could not be cancelled (a composition) is dropped, not kept.
  capture.addEventListener("input", () => {
    capture.value = "";
  });
};

function modifiersOf(event) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export const createInteractView = ({ input, visual, observe }) => {
  const image = /** @type {HTMLImageElement} */ (document.getElementById("visual"));
  const replies = [];
  const stats = { sent: 0, noFrame: 0, letterbox: 0, coalesced: 0 };
  let attached = null;
  const capture = keyCapture();
  /** @type {{ width: number, height: number } | null} */
  let natural = null;
  let lastPoint = null;
  const hold = createHold(() =>
    attached && input.interactSession(attached).renewing
      ? aim(attached, "hold", {}).catch(() => null)
      : null,
  );

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
    hold.sent();
    return input.interactEvent(name, kind, { ...target, ...fields }).then(record);
  };

  const send = (kind) => (item) => aim(item.name, kind, item.point, item.fields);
  const move = coalescer(send("pointerMove"), (_older, newer) => newer, stats);
  const wheel = coalescer(send("wheel"), sumWheel, stats);

  const buttonOf = (event) => BUTTONS[event.button] ?? "left";

  // An up off the image still lets go of a press that began on it, where the pointer last was.
  const pointOf = (event, kind) => {
    const box = image.getBoundingClientRect();
    const point = imagePoint(box, natural, { x: event.clientX, y: event.clientY });
    if (point || kind !== "pointerUp") return point;
    return hold.holds(buttonOf(event)) ? lastPoint : null;
  };

  const pressOrRelease = (event, kind, point, fields) => {
    event.preventDefault();
    if (kind === "pointerDown") hold.press(fields.button);
    else hold.release(fields.button);
    // The click on the frame is where the owner's keys go next.
    if (kind === "pointerDown") capture.focus({ preventScroll: true });
    const clickCount = Math.min(Math.max(event.detail, 1), 3);
    void aim(attached, kind, point, { ...fields, clickCount });
  };

  const onPointer = (event) => {
    if (!attached || !natural) return;
    const kind = KINDS[event.type];
    // An up is heard on the whole page; it is sent only for a press the image began.
    if (kind === "pointerUp" && !hold.holds(buttonOf(event))) return;
    const point = pointOf(event, kind);
    if (!point) {
      stats.letterbox += 1;
      return;
    }
    lastPoint = point;
    const pressed = kind === "pointerMove" && event.buttons === 0 ? "none" : buttonOf(event);
    const fields = { button: pressed, clickCount: 0, modifiers: modifiersOf(event) };
    if (kind === "pointerMove") move({ name: attached, point, fields });
    else pressOrRelease(event, kind, point, fields);
  };
  image.addEventListener("mousedown", onPointer);
  image.addEventListener("pointermove", onPointer);
  window.addEventListener("mouseup", onPointer);
  window.addEventListener("blur", hold.clear);

  image.addEventListener(
    "wheel",
    (event) => {
      const aimed = attached && natural ? wheelOf(event, image, natural) : null;
      if (!aimed) return;
      event.preventDefault();
      wheel({ name: attached, ...aimed });
    },
    { passive: false },
  );
  listenKeys(capture, (kind, fields) => attached && aim(attached, kind, {}, fields), hold);
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
    interactKeepalive: hold.enable,
    interactView: () => {
      const view = { attached, natural, stats: { ...stats }, replies: [...replies] };
      return { ...view, hold: hold.stats() };
    },
  };
};
