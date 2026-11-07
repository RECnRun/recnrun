// W7 slices B and C: one checked input event, aimed at a frame, dispatched on the worker's tab.
import { POINTER_KINDS, mouseParams } from "./interact-frames.js";
import { keyParams, textFits, wheelParams } from "./interact-keys.js";
import { holding, insertText, key, liveDocument, mouse, releaseHeld } from "./interact-tab.js";

// A down, a key, or a text acts on whatever document the tab holds: its loader is read again.
const FRESH = new Set(["pointerDown", "key", "text"]);
const DEADMAN_MS = 1_000;

const effect = (message, entry, zoom) => {
  if (POINTER_KINDS.includes(message.kind)) return mouse(mouseParams(message, entry, zoom));
  if (message.kind === "wheel") return mouse(wheelParams(message, entry, zoom));
  if (message.kind === "key") return key(keyParams(message));
  return insertText(message.text);
};

// Refused before any document is read: a key outside the table, a text over 4 KiB.
const unsupported = (message) => {
  if (message.kind === "key" && !keyParams(message)) return "INPUT_UNSUPPORTED";
  if (message.kind === "text" && !textFits(message.text)) return "TEXT_TOO_LONG";
  return null;
};

/**
 * `deps`: { frames, refuse, revoke(reason), serial(work), stats }. The returned function handles
 * one admitted INPUT_EVENT; while anything stays held and no event follows, a dead man lets go.
 */
export const createEvents = ({ frames, refuse, revoke, serial, stats }) => {
  let deadman = null;
  const arm = (receivedAt) => {
    clearTimeout(deadman);
    deadman = null;
    if (!holding()) return;
    const wait = Math.max(0, DEADMAN_MS - (Date.now() - receivedAt));
    deadman = setTimeout(() => void serial(() => releaseHeld("DEADMAN")), wait);
  };

  const dispatch = async (message) => {
    const { leaseId, seq } = message;
    const early = unsupported(message);
    if (early) return refuse(early, { leaseId, seq });
    const live = await liveDocument(FRESH.has(message.kind));
    if (!live.allowed) {
      await revoke("TARGET_OFF_POLICY");
      return refuse("TARGET_OFF_POLICY", { leaseId, seq });
    }
    const refused = frames.check(message, live);
    if (refused) return refuse(refused, { leaseId, seq });
    await effect(message, frames.get(message.frameSeq), live.zoom);
    stats.dispatched += 1;
    return { ok: true, leaseId, seq };
  };

  return (message) => {
    const receivedAt = Date.now();
    return dispatch(message).finally(() => arm(receivedAt));
  };
};
