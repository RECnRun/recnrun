// Owner flow: the interaction tab's viewport follows the master's panel, within the policy bounds.
export const VIEWPORT_BOUNDS = { minWidth: 320, minHeight: 240, maxWidth: 1920, maxHeight: 1080 };
// The interact screencast's size before the master names one.
const DEFAULT = { width: 960, height: 540 };

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The effective size, or INPUT_INVALID when a side is not an integer of CSS px. */
export const clampViewport = ({ width, height }, bounds = VIEWPORT_BOUNDS) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return "INPUT_INVALID";
  return {
    width: clamp(width, bounds.minWidth, bounds.maxWidth),
    height: clamp(height, bounds.minHeight, bounds.maxHeight),
  };
};

/** The viewport applied last and the input seq that applied it; 0 before any. */
export const createViewport = () => {
  let state = { ...DEFAULT, seq: 0 };
  return {
    current: () => ({ ...state }),
    size: (mode, base) =>
      mode === "interact" ? { maxWidth: state.width, maxHeight: state.height } : base,
    apply: ({ width, height }, seq) => {
      state = { width, height, seq };
    },
    reset: () => {
      state = { ...DEFAULT, seq: 0 };
    },
  };
};

export const viewport = createViewport();
