// W6 slice D: one card per worker; observation stays off until the owner asks for it.
import {
  ACTIVE,
  OBSERVING,
  cardState,
  fpsOf,
  linkOpen,
  newCard,
  readEvents,
  renderCard,
} from "./card.js";
import { createViewer } from "./viewer.js";

const POLL_MS = 1_000;
const TICK_MS = 250;

const element = (tag, text = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};

// A new object URL per frame; the card's previous one is revoked.
const show = (image, previous, blob) => {
  const url = URL.createObjectURL(blob);
  image.src = url;
  if (previous) URL.revokeObjectURL(previous);
  return url;
};

const run = (card, action) =>
  action().catch((error) => {
    card.note = String(error?.message ?? error);
  });

/** Starts, switches, and stops a card's session through the signed observe requests. */
const createActions = (observe) => {
  const begin = async (card, mode) => {
    const reply = await observe.observeStart(card.name, card.jobId, mode);
    if (!reply.ok) throw new Error(reply.code);
    card.errorsSeen = observe.observeEvents(card.name).errors.length;
    card.epoch = observe.observeSession(card.name).sessionEpoch;
    card.error = null;
    card.observedAt = Date.now();
    card.observation = mode.toUpperCase();
  };
  const setMode = async (card, mode) => {
    if (!OBSERVING.has(card.observation)) return begin(card, mode);
    const reply = await observe.observeMode(card.name, mode);
    if (!reply.ok) throw new Error(reply.code);
    card.observation = mode.toUpperCase();
  };
  const stop = async (card, next) => {
    if (OBSERVING.has(card.observation)) await observe.observeStop(card.name);
    card.observation = next;
  };
  return { setMode, stop };
};

const button = (card, label, action) => {
  const node = element("button", label);
  node.type = "button";
  node.addEventListener("click", () => void run(card, action));
  return node;
};

// The job's state and its last action, through the job-status round trip the journal uses.
const poll = async (links, visual, card) => {
  if (card.polling || !linkOpen(links, card.name) || (card.job && !ACTIVE.has(card.job))) return;
  card.polling = true;
  try {
    const { jobs } = await visual.jobStatus(card.name, [card.jobId]);
    card.job = jobs[0]?.state ?? null;
    card.ops = jobs[0]?.ops ?? [];
  } finally {
    card.polling = false;
  }
};

export const createDashboard = ({ links, visual, observe }) => {
  const cards = new Map();
  const list = /** @type {HTMLElement} */ (document.getElementById("cards"));
  const { setMode, stop } = createActions(observe);
  const stateOf = (card) => cardState(links, card);
  const viewer = createViewer({
    live: (card) => setMode(card, "live"),
    back: (card) => (card.observation === "LIVE" ? setMode(card, "thumbnail") : undefined),
    stop: (card) => stop(card, "OFF"),
    stateOf,
    fpsOf,
    run,
  });

  visual.onVisualFrame((name, entry) => {
    const card = cards.get(name);
    if (!card || !OBSERVING.has(card.observation)) return;
    card.frame = entry;
    card.times = [...card.times.filter((at) => Date.now() - at <= 2_000), entry.at];
    card.url = show(card.image, card.url, entry.blob);
    viewer.frame(card, entry);
  });

  const add = (name, jobId) => {
    const card = newCard(name, links.get(name).proven.workerId, jobId);
    card.text = element("p");
    card.image = element("img");
    card.image.alt = `Last frame of worker ${name}`;
    card.item = element("li");
    card.item.append(
      card.text,
      card.image,
      button(card, "Observe", () => setMode(card, "thumbnail")),
      button(card, "Pause", () => stop(card, "PAUSED")),
      button(card, "Open viewer", () => viewer.open(card)),
    );
    // A new job on the same link replaces that link's card.
    cards.get(name)?.item.remove();
    list.append(card.item);
    cards.set(name, card);
    renderCard(links, card);
    return stateOf(card);
  };

  setInterval(() => {
    for (const card of cards.values()) void poll(links, visual, card).catch(() => undefined);
  }, POLL_MS);
  setInterval(() => {
    for (const card of cards.values()) {
      readEvents(observe, card);
      renderCard(links, card);
    }
    viewer.render();
  }, TICK_MS);

  return {
    dashboardAdd: add,
    dashboardState: () => ({ cards: [...cards.values()].map(stateOf), viewer: viewer.state() }),
    cardPixel: (name, fx, fy) => visual.visualPixel(fx, fy, name),
  };
};
