import {
  DOM_EVENT_TYPES,
  HOOK_VERSION,
  MAX_CAPTURED_TEXT,
  OBSERVER_BINDING,
} from "@recnrun/protocol";
import { DOM_CAPTURE } from "./hook-dom.ts";

// Runs in the page's main world before any application script, so the page can detect it.
// Chrome reuses a popup's initial about:blank window, script context included, for its first
// same-origin document without running new-document scripts again; the hook then starts the new
// document's identity, and posts its install, the first time `__recnrunHook` is read there.
// When the binding is not there yet (a running page hooked late), an accessor waits for it:
// `Runtime.addBinding` assigns it with an ordinary [[Set]], which calls the setter and flushes.
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
  const send = (kind, type, payload) => {
    current.seq += 1;
    const { seq, documentId } = current;
    const message = stringify({ kind, type, seq, documentId, ts: now(), targetId: config.targetId, payload });
    if (typeof binding === "function") binding(message);
    else queue.push(message);
  };
  const begin = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const documentId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const hook = Object.freeze({ version: config.version, installedAt: now(), documentId });
    current = { document, documentId, hook, seq: 0 };
    send("lifecycle", "document.hook-installed", { url: location.href, hookVersion: config.version });
  };
  const ensure = () => {
    if (current?.document !== document) begin();
    return current;
  };
  Object.defineProperty(window, "__recnrunHook", { get: () => ensure().hook });
  ensure();
  ${DOM_CAPTURE}
})`;

/** The script `Page.addScriptToEvaluateOnNewDocument` injects into every document of `targetId`. */
export function hookSource(targetId: string): string {
  const config = {
    binding: OBSERVER_BINDING,
    version: HOOK_VERSION,
    targetId,
    events: DOM_EVENT_TYPES,
    maxText: MAX_CAPTURED_TEXT,
  };
  return `${HOOK}(${JSON.stringify(config)});`;
}
