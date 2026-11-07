// The harness calls globalThis.lab through CDP; the offscreen document holds the link.
import { setSink, start, stop } from "./capture.js";
import { visualLab } from "./capture-lab.js";
import { labState, release, setKnob } from "./knobs.js";
import { all, load, recover, resultFile } from "./ledger.js";
import { statuses, submit } from "./runner.js";

// Wakes the worker at browser start, so a job cut by a restart is closed before any link.
chrome.runtime.onStartup.addListener(() => undefined);
const recovered = recover();

const ensureOffscreen = async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WEB_RTC"],
    justification: "Answers the master page's WebRTC offer.",
  });
};

const ask = async (message) => {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
};

// Frames leave over chrome.runtime as base64; the offscreen document owns visual.v1.
const toOffscreen = (frame) => {
  const { bootId, jobId, tabId, epoch, frameSeq, width, height, capturedAtMs, data } = frame;
  const meta = { bootId, jobId, targetId: tabId, epoch, frameSeq, width, height, capturedAtMs };
  return ask({ type: "visual-frame", frame: { ...meta, data, queuedAt: Date.now() } });
};

// lab: replaced by OBSERVE_START and OBSERVE_STOP in slice C.
const visualControl = (message) => {
  if (message.type === "visual-stop") {
    setSink(null);
    return stop();
  }
  setSink(toOffscreen);
  return start({ mode: message.mode });
};

const provision = async () => (await chrome.storage.local.get("provision")).provision;

const handle = async (message) => {
  await recovered;
  if (message.type === "job") {
    labState.linkClosedAt = null;
    return submit(message.job, await provision());
  }
  if (message.type === "job-status") return { jobs: await statuses(message.jobIds) };
  if (message.type.startsWith("visual-")) return visualControl(message);
  if (message.type === "link-closed") labState.linkClosedAt = Date.now();
  return { ok: true };
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.target !== "runner") return false;
  handle(message).then(respond, (error) => respond({ error: String(error) }));
  return true;
});

globalThis.lab = {
  identity: () => ask({ type: "identity" }),
  answer: (offer) => ask({ type: "answer", offer }),
  ready: () => recovered,
  provisioned: provision,
  provision: (value) => chrome.storage.local.set({ provision: value }).then(() => true),
  setKnob: (knob) => setKnob(knob).then(() => true),
  state: () => ({ reached: labState.reached, linkClosedAt: labState.linkClosedAt }),
  release,
  // The same admission path a relayed job takes, for tests that need no link.
  submit: async (job) => submit(job, await provision()),
  job: load,
  jobs: all,
  resultFile,
  visual: {
    ...visualLab,
    burst: (count, padBytes) => ask({ type: "visual-burst", count, padBytes }),
    transport: () => ask({ type: "visual-stats" }),
  },
};
