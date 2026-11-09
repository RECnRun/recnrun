// Offscreen side of the owner flow: polls the exchange folder and reports the link state.
import { POLL_MS, createFileSignal, readFileJson } from "./file-signal.js";
import { createLinkState } from "./link-state.js";
import { createOfferCheck } from "./offer-file.js";

// A live link's state.json is rewritten well inside the launcher's 30 s freshness window.
const STATE_REFRESH_MS = 10_000;
let started = false;

const toRunner = (message) => chrome.runtime.sendMessage({ target: "runner", ...message });
const emit = (name, body) => toRunner({ type: "signal-file", name, body }).catch(() => false);
const log = (text) => console.info(`[worker] ${text}`);

/** Starts once per offscreen document; `connect` answers an SDP and reports its channel events. */
export const startFileLink = ({ exchangeUrl, context }, { connect, identity }) => {
  if (started) return;
  started = true;
  const link = createLinkState({ onChange: (change) => void emit("state.json", change) });
  const events = (attempt) => ({
    opened: () => link.opened(attempt),
    closed: () => link.closed(attempt),
    lost: () => link.lost(attempt),
  });
  const deps = {
    readJson: readFileJson,
    check: createOfferCheck(),
    link,
    connect: (sdp, attempt) => connect(sdp, events(attempt)),
    bootId: async () => (await toRunner({ type: "boot" })).bootId,
    identity,
    emit,
    log,
  };
  const signal = createFileSignal({ exchangeUrl, context, deps });
  const loop = async () => {
    await signal.tick().catch((error) => log(`poll failed: ${String(error)}`));
    setTimeout(() => void loop(), POLL_MS);
  };
  void emit("state.json", { state: "unlinked", attempt: null, at: Date.now() });
  setInterval(() => {
    if (link.state() === "unlinked") return;
    void emit("state.json", { state: link.state(), attempt: link.attempt(), at: Date.now() });
  }, STATE_REFRESH_MS);
  void loop();
};
