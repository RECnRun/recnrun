// Owner flow: the interact screencast's JPEG quality follows its frame sizes against a byte budget.
import { CAPS } from "./observe-gate.js";

const START = 70;
const STEP = 10;
const FLOOR = 30;
// A quality change restarts the screencast, so it changes at most once per second.
const HOLD_MS = 1_000;

export const createQuality = ({ budget, now = Date.now }) => {
  let value = START;
  let changedAt = -Infinity;
  const next = (bytes) => {
    if (bytes > budget) return Math.max(value - STEP, FLOOR);
    return bytes < budget / 2 ? Math.min(value + STEP, START) : value;
  };
  return {
    value: () => value,
    /** True when `bytes` moved the quality, so the screencast must restart to apply it. */
    observe: (bytes) => {
      const wanted = next(bytes);
      if (wanted === value || now() - changedAt < HOLD_MS) return false;
      value = wanted;
      changedAt = now();
      return true;
    },
    reset: () => {
      value = START;
      changedAt = -Infinity;
    },
  };
};

// One frame's share of the interact rate: a bigger frame cannot keep the full frame rate.
export const interactQuality = createQuality({
  budget: Math.floor(CAPS.interact.bytesPerSecond / CAPS.interact.fps),
});

export const qualityFor = (mode, fallback) =>
  mode === "interact" ? interactQuality.value() : fallback;
