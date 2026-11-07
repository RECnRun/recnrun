// W6 slice D: a worker card's state, as the dashboard shows it and the lab reads it.
import { FINAL } from "./observe-client.js";

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
  restartsSeen: 0,
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

// The shown image's own capture time: a static page or a stalled stream both make it STALE.
const frameAge = (card) => Date.now() - (card.frame?.capturedAtMs ?? card.observedAt);
const stale = (card) => OBSERVING.has(card.observation) && frameAge(card) > STALE_MS;
// Liveness is the telemetry's, apart from the image: a live worker may have nothing new to show.
const lastSign = (card) => Math.max(card.frame?.at ?? 0, card.heartbeatAt, card.observedAt);
const silent = (card) => OBSERVING.has(card.observation) && Date.now() - lastSign(card) > STALE_MS;

export const fpsOf = (card) => card.times.filter((at) => Date.now() - at <= 1_000).length;

export const cardState = (links, card) => ({
  name: card.name,
  workerId: card.workerId,
  jobId: card.jobId,
  status: statusOf(links, card),
  observation: card.observation,
  stale: stale(card),
  silent: silent(card),
  hasFrame: card.frame !== null,
  frameAgeMs: card.frame ? frameAge(card) : null,
  fps: fpsOf(card),
  note: card.note,
});

/** The worker's telemetry: a heartbeat marks it live; an error or a final end stops the card. */
export const readEvents = (observe, card) => {
  if (!OBSERVING.has(card.observation)) return;
  const events = observe.observeEvents(card.name);
  // A restart after a lapse carries on under a new session epoch.
  card.epoch = observe.observeSession(card.name).sessionEpoch ?? card.epoch;
  const beat = events.heartbeats.at(-1);
  if (beat && beat !== card.beat) {
    card.beat = beat;
    card.heartbeatAt = Date.now();
    const ended = beat.state === "ENDED" && beat.sessionEpoch === card.epoch;
    if (ended && FINAL.has(beat.reason)) card.observation = "OFF";
  }
  if (events.restarts.slice(card.restartsSeen).some((entry) => entry.gaveUp)) {
    card.observation = "OFF";
  }
  if (events.errors.length > card.errorsSeen) {
    card.error = events.errors.at(-1).code;
    card.observation = "OFF";
  }
};

export const renderCard = (links, card) => {
  const { status, observation, frameAgeMs, stale: late, silent: quiet } = cardState(links, card);
  const age = frameAgeMs === null ? "no frame" : `frame ${(frameAgeMs / 1_000).toFixed(1)} s old`;
  const parts = [card.name, card.workerId.slice(0, 8), `job ${card.jobId.slice(0, 8)}`];
  parts.push(status, observation, age);
  if (late) parts.push("STALE");
  if (quiet) parts.push("worker silent");
  if (card.note) parts.push(card.note);
  card.text.textContent = parts.join(" · ");
};
