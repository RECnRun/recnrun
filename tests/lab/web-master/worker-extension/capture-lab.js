// Lab-only readouts and faults of the capture: pixels, a background-tab probe, a closed tab.
import { boundTarget, captureStats, lastFrame, MODES, start, stop } from "./capture.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The RGB of the latest frame at fractions `fx`, `fy` of its size, or null without a frame. */
const pixel = async (fx, fy) => {
  const frame = lastFrame();
  if (!frame) return null;
  const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: "image/jpeg" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const x = Math.floor(fx * bitmap.width);
  const y = Math.floor(fy * bitmap.height);
  const { data } = context.getImageData(x, y, 1, 1);
  return [data[0], data[1], data[2]];
};

/** Counts screencast frames of a background tab of its own, with or without focus emulation. */
const probeBackground = async (url, focus, ms) => {
  const tab = await chrome.tabs.create({ url, active: false });
  const target = { tabId: tab.id };
  let frames = 0;
  const listener = (source, method, params) => {
    if (source.tabId !== tab.id || method !== "Page.screencastFrame") return;
    frames += 1;
    void chrome.debugger.sendCommand(target, "Page.screencastFrameAck", {
      sessionId: params.sessionId,
    });
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    await chrome.debugger.attach(target, "1.3");
    await chrome.debugger.sendCommand(target, "Page.enable");
    if (focus) {
      await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
    }
    await chrome.debugger.sendCommand(target, "Page.startScreencast", {
      format: "jpeg",
      quality: 50,
      ...MODES.thumbnail,
    });
    await sleep(ms);
    const { visibilityState } = await visibility(target);
    return { focus, frames, ms, fps: Number(((frames * 1_000) / ms).toFixed(2)), visibilityState };
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    await chrome.debugger.detach(target).catch(() => false);
    await chrome.tabs.remove(tab.id).catch(() => false);
  }
};

const visibility = async (target) => {
  const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: "({ visibilityState: document.visibilityState })",
    returnByValue: true,
  });
  return result.value;
};

const FAULTS = {
  "close-tab": (tabId) => chrome.tabs.remove(tabId),
  "chrome-url": (tabId) => chrome.tabs.update(tabId, { url: "chrome://version/" }),
};

const fault = async (kind) => {
  const target = boundTarget();
  if (!target) return false;
  await FAULTS[kind](target.tabId);
  return true;
};

/** The latest frame as base64 JPEG, for evidence files. */
const latest = () => lastFrame()?.data ?? null;

export const visualLab = {
  start,
  stop,
  stats: captureStats,
  pixel,
  latest,
  probeBackground,
  fault,
};
