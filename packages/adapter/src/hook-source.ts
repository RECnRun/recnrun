import {
  DEFAULT_OBSERVER_BUFFER,
  DOM_EVENT_TYPES,
  HOOK_VERSION,
  MAX_CAPTURED_TEXT,
  OBSERVER_BINDING,
  STORAGE_OPERATIONS,
} from "@recnrun/protocol";
import { DOM_CAPTURE } from "./hook-dom.ts";
import { STORAGE_CAPTURE } from "./hook-storage.ts";

// Runs in the page's main world before any application script, so the page can detect it.
// Chrome reuses a popup's initial about:blank window, script context included, for its first
// same-origin document without running new-document scripts again; the hook then starts the new
// document's identity, and posts its install, the first time `__recnrunHook` is read there.
// When the binding is not there yet (a running page hooked late), an accessor waits for it:
// `Runtime.addBinding` assigns it with an ordinary [[Set]], which calls the setter and flushes.
// Every message stays in the document's bounded window until the adapter acknowledges it through
// `__recnrunHook.ack`, which can also ask for a resend; a full window drops new messages and
// reports their sequence range in one `buffer.exhausted` message once there is room again.
const HOOK = `(function (config) {
  "use strict";
  if (Object.prototype.hasOwnProperty.call(window, "__recnrunHook")) return;
  const stringify = JSON.stringify;
  const now = performance.now.bind(performance);
  let binding = window[config.binding];
  const queue = [];
  if (typeof binding !== "function") {
    Object.defineProperty(window, config.binding, {
      configurable: true,
      get: () => binding,
      set: (value) => {
        binding = value;
        while (typeof binding === "function" && queue.length > 0) binding(queue.shift());
      },
    });
  }
  let current;
  const transmit = (message) => {
    if (typeof binding === "function") binding(message);
    else queue.push(message);
  };
  const deliver = (state, kind, type, payload) => {
    state.seq += 1;
    const { seq, documentId } = state;
    const message = stringify({ kind, type, seq, documentId, ts: now(), targetId: config.targetId, payload });
    state.unacked.push([seq, message]);
    transmit(message);
  };
  const reportLoss = (state) => {
    const loss = state.loss;
    if (!loss) return;
    state.loss = undefined;
    deliver(state, "gap", "buffer.exhausted", { ...loss, lost: loss.toSeq - loss.fromSeq + 1 });
  };
  const hasRoom = (state) => state.unacked.length < config.buffer;
  const send = (kind, type, payload) => {
    const state = current;
    if (hasRoom(state)) reportLoss(state);
    if (hasRoom(state)) return deliver(state, kind, type, payload);
    state.seq += 1;
    state.loss ??= { fromSeq: state.seq, toSeq: state.seq, kinds: [] };
    state.loss.toSeq = state.seq;
    if (!state.loss.kinds.includes(kind)) state.loss.kinds.push(kind);
  };
  const acknowledge = (state) => (documentId, upTo, resendFrom) => {
    if (documentId !== state.documentId) return;
    const kept = state.unacked.findIndex(([seq]) => seq > upTo);
    state.unacked.splice(0, kept === -1 ? state.unacked.length : kept);
    for (const [seq, message] of state.unacked) if (seq >= resendFrom) transmit(message);
    if (hasRoom(state)) reportLoss(state);
  };
  const begin = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const documentId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const state = { document, documentId, seq: 0, unacked: [], loss: undefined };
    state.hook = Object.freeze({ version: config.version, installedAt: now(), documentId, ack: acknowledge(state) });
    current = state;
    send("lifecycle", "document.hook-installed", { url: location.href, hookVersion: config.version });
  };
  const ensure = () => {
    if (current?.document !== document) begin();
    return current;
  };
  Object.defineProperty(window, "__recnrunHook", { get: () => ensure().hook });
  ensure();
  // The document is going away: its open gap is reported even past the window's bound.
  window.addEventListener("pagehide", () => reportLoss(current), { capture: true, passive: true });
  ${DOM_CAPTURE}
  ${STORAGE_CAPTURE}
})`;

/** The script `Page.addScriptToEvaluateOnNewDocument` injects into every document of `targetId`. */
export function hookSource(targetId: string, buffer = DEFAULT_OBSERVER_BUFFER): string {
  const config = {
    binding: OBSERVER_BINDING,
    version: HOOK_VERSION,
    targetId,
    buffer,
    events: DOM_EVENT_TYPES,
    maxText: MAX_CAPTURED_TEXT,
    storageOperations: STORAGE_OPERATIONS,
  };
  return `${HOOK}(${JSON.stringify(config)});`;
}
