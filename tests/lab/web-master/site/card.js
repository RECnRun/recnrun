// W6 slice D: a worker card's state, as the dashboard shows it and the lab reads it.

const STALE_MS = 3_000;
export const ACTIVE = new Set(["RUNNING", "PENDING", "NOT_FOUND"]);
export const OBSERVING = new Set(["THUMBNAIL", "LIVE"]);

export const newCard = (name, workerId, jobId) => ({
  name,
  workerId,
  jobId,
  observation: "OFF",
  job: null,
  ops: [],
  error: null,
  note: "",
  frame: null,
  times: [],
  heartbeatAt: 0,
  observedAt: 0,
  errorsSeen: 0,
  epoch: 0,
  url: "",
});

export const linkOpen = (links, name) => {
  const link = links.get(name);
  if (!link || link.channel.readyState !== "open") return false;
  return !["disconnected", "failed", "closed"].includes(link.pc.connectionState);
};

const statusOf = (links, card) => {
  if (!linkOpen(links, card.name)) return "DISCONNECTED";
  if (card.job && !ACTIVE.has(card.job)) return card.job;
  return card.error ? "STREAM_UNAVAILABLE" : "RUNNING";
};

const lastSign = (card) => Math.max(card.frame?.at ?? 0, card.heartbeatAt, card.observedAt);
const stale = (card) => OBSERVING.has(card.observation) && Date.now() - lastSign(card) > STALE_MS;

export const fpsOf = (card) => card.times.filter((at) => Date.now() - at <= 1_000).length;

export const cardState = (links, card) => ({
  name: card.name,
  workerId: card.workerId,
  jobId: card.jobId,
  status: statusOf(links, card),
  observation: card.observation,
  stale: stale(card),
  hasFrame: card.frame !== null,
  frameAgeMs: card.frame ? Date.now() - card.frame.at : null,
  fps: fpsOf(card),
  note: card.note,
});

/** The worker's telemetry: a heartbeat keeps the card fresh; an error or an end stops it. */
export const readEvents = (observe, card) => {
  if (!OBSERVING.has(card.observation)) return;
  const events = observe.observeEvents(card.name);
  const beat = events.heartbeats.at(-1);
  if (beat && beat !== card.beat) {
    card.beat = beat;
    card.heartbeatAt = Date.now();
    if (beat.state === "ENDED" && beat.sessionEpoch === card.epoch) card.observation = "OFF";
  }
  if (events.errors.length > card.errorsSeen) {
    card.error = events.errors.at(-1).code;
    card.observation = "OFF";
  }
};

export const renderCard = (links, card) => {
  const { status, observation, frameAgeMs, stale: late } = cardState(links, card);
  const age = frameAgeMs === null ? "no frame" : `frame ${(frameAgeMs / 1_000).toFixed(1)} s old`;
  const parts = [card.name, card.workerId.slice(0, 8), `job ${card.jobId.slice(0, 8)}`];
  parts.push(status, observation, age);
  if (late) parts.push("STALE");
  if (card.note) parts.push(card.note);
  card.text.textContent = parts.join(" · ");
};
