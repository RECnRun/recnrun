// W7 slices B and C: one checked input event, aimed at a frame, dispatched on the worker's tab.
import { POINTER_KINDS, mouseParams } from "./interact-frames.js";
import { keyParams, textFits, wheelParams } from "./interact-keys.js";

// A down, a key, or a text acts on whatever document the tab holds: its loader is read again.
const FRESH = new Set(["pointerDown", "key", "text"]);
const DEADMAN_MS = 1_000;

const effect = (tab, message, entry, zoom) => {
  if (POINTER_KINDS.includes(message.kind)) return tab.mouse(mouseParams(message, entry, zoom));
  if (message.kind === "wheel") return tab.mouse(wheelParams(message, entry, zoom));
  if (message.kind === "key") return tab.key(keyParams(message));
  return tab.insertText(message.text);
};

// Refused before any document is read: a key outside the table, a text over 4 KiB.
const unsupported = (message) => {
  if (message.kind === "key" && !keyParams(message)) return "INPUT_UNSUPPORTED";
  if (message.kind === "text" && !textFits(message.text)) return "TEXT_TOO_LONG";
  return null;
};

// Checked against the document now, then the lease once more with no await before the effect.
const check = async ({ frames, tab, authorized }, message) => {
  // A read that fails because the revoke closed the tab is that revoke, not a worker error.
  const live = await tab.liveDocument(FRESH.has(message.kind)).catch((error) => {
    if (authorized(message.leaseId)) throw error;
    return null;
  });
  if (!live || !authorized(message.leaseId)) return { code: "SESSION_REVOKED" };
  if (!live.allowed) return { code: "TARGET_OFF_POLICY", revoke: true };
  const refused = frames.check(message, live);
  if (refused) return { code: refused };
  return authorized(message.leaseId) ? { live } : { code: "SESSION_REVOKED" };
};

/**
 * `deps`: { frames, refuse, revoke(reason), serial(work), stats, tab, authorized(leaseId) }. The
 * returned function handles one admitted INPUT_EVENT; while anything stays held and no accepted
 * event follows, a dead man lets go, and a release it cannot confirm revokes.
 */
export const createEvents = (deps) => {
  const { frames, refuse, revoke, serial, stats, tab } = deps;
  let deadman = null;
  const letGo = async () => {
    if (!(await tab.releaseHeld("DEADMAN"))) revoke("INPUT_STATE_UNKNOWN");
  };
  const arm = (receivedAt) => {
    clearTimeout(deadman);
    deadman = null;
    if (!tab.holding()) return;
    const wait = Math.max(0, DEADMAN_MS - (Date.now() - receivedAt));
    deadman = setTimeout(() => void serial(letGo), wait);
  };

  const dispatch = async (message) => {
    const { leaseId, seq } = message;
    const early = unsupported(message);
    if (early) return refuse(early, { leaseId, seq });
    const checked = await check(deps, message);
    if (checked.revoke) revoke(checked.code);
    if (checked.code) return refuse(checked.code, { leaseId, seq });
    // A hold acts on nothing: checked like an event, it only re-arms the dead man.
    if (message.kind === "hold") stats.holds += 1;
    else {
      await effect(tab, message, frames.get(message.frameSeq), checked.live.zoom);
      stats.dispatched += 1;
    }
    return { ok: true, leaseId, seq };
  };

  return async (message) => {
    const receivedAt = Date.now();
    const reply = await dispatch(message);
    if (reply.ok) arm(receivedAt);
    return reply;
  };
};
