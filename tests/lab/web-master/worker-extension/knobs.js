// Lab-only barriers (plan §4 "Lab-only knob"): the runner stops at one named point until released.
export const labState = { reached: null, linkClosedAt: null };
let releaser = null;

export const setKnob = (knob) =>
  knob ? chrome.storage.local.set({ knob }) : chrome.storage.local.remove("knob");

/** Phases: `between` (before the op), `applying` (persisted, no effect yet), `afterEffect`. */
export const barrier = async (index, phase) => {
  const { knob } = await chrome.storage.local.get("knob");
  if (!knob || knob.index !== index || knob.phase !== phase) return;
  await new Promise((resolve) => {
    labState.reached = { index, phase, at: Date.now() };
    releaser = resolve;
  });
  labState.reached = null;
  releaser = null;
};

export const release = () => {
  if (!releaser) return false;
  releaser();
  return true;
};
