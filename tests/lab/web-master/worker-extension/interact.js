// W7 slices A and B: link-bound interactive sessions on the worker's own tab, sharing the claim.
import { bootId, captureStats } from "./capture.js";
import { createStartCheck } from "./input-check.js";
import { INPUT_TYPES, inputError } from "./input-schema.js";
import { createEvents } from "./interact-events.js";
import { createFrames, geometryOf } from "./interact-frames.js";
import { createLeases } from "./interact-lease.js";
import { closeTab, isOpen, openTab, refresh } from "./interact-tab.js";
import { resize, tabState } from "./interact-tab.js";
import { setSentHook } from "./observe.js";
import { claimInteraction, claimed, releaseInteraction } from "./runner.js";

const TICK_MS = 250;
const limits = { leaseMs: 3_000, renewMs: 1_000 };
const starts = createStartCheck();
const leases = createLeases({ leaseMs: limits.leaseMs });
const frames = createFrames();
const stats = {
  started: 0,
  dispatched: 0,
  holds: 0,
  refused: {},
  revoked: {},
  errors: [],
  framesSent: 0,
};
// A static page draws nothing: its screencast restarts so the newest frame stays fresh.
const QUIET_MS = 750;

const provision = async () => (await chrome.storage.local.get("provision")).provision;
const latched = async () => (await chrome.storage.local.get("interactStop")).interactStop === true;

// Interaction is off unless provisioning turned it on, and a latched stop holds until cleared.
const gateError = async (provisioned) => {
  if (!provisioned?.masterKey) return "UNPROVISIONED";
  if (provisioned.interactEnabled !== true) return "INTERACT_DISABLED";
  return (await latched()) ? "WORKER_STOPPED" : null;
};

const count = (bucket, code) => {
  bucket[code] = (bucket[code] ?? 0) + 1;
};
const refuse = (code, extra = {}) => {
  count(stats.refused, code);
  return { ok: false, code, ...extra };
};

const push = (linkId, message) =>
  void chrome.runtime
    .sendMessage({ target: "offscreen", type: "input-push", linkId, message })
    .catch(() => false);

// The tab is closed before the claim is freed, so a job never shares the worker with it.
const end = async (ended) => {
  if (!ended) return;
  count(stats.revoked, ended.reason);
  frames.clear();
  await closeTab().catch((error) => stats.errors.push(String(error)));
  releaseInteraction(ended.interactId);
  const { leaseId, interactId, reason } = ended;
  push(ended.linkId, { type: "INTERACT_REVOKED", leaseId, interactId, reason });
};

// Every frame the master gets is announced on input.v1 with what an event must name to aim at it.
setSentHook((frame, sessionEpoch) => {
  const lease = leases.current();
  if (!lease || frame.jobId !== lease.interactId) return;
  const { loaderId } = tabState().tab ?? {};
  const geometry = frame.source === "screencast" ? geometryOf(frame.metadata) : null;
  const { frameSeq, bootId: boot } = frame;
  const entry = { frameSeq, bootId: boot, sessionEpoch, loaderId, geometry };
  // A screenshot carries no geometry, so it is never an input target.
  if (geometry && loaderId) frames.add(entry);
  stats.framesSent += 1;
  push(lease.linkId, { type: "INTERACT_FRAME", leaseId: lease.leaseId, ...entry });
});

let queue = Promise.resolve();
const serial = (work) => {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
};
const revoke = (reason) => end(leases.revoke(reason));
const event = createEvents({ frames, refuse, revoke, serial, stats });

const challenge = async (link) => {
  const refused = await gateError(await provision());
  if (refused) return refuse(refused);
  const nonce = starts.issue(link.linkId);
  if (!nonce) return refuse("RATE_LIMITED");
  const { masterFingerprint, workerFingerprint } = link;
  const workerId = chrome.runtime.id;
  return { ok: true, nonce, bootId: bootId(), workerId, masterFingerprint, workerFingerprint };
};

const start = async (message, link) => {
  const verify = async () => {
    const provisioned = await provision();
    const refused = await gateError(provisioned);
    if (refused) return refused;
    const { masterKey, allowlist } = provisioned;
    const context = { masterKey, allowlist, workerId: chrome.runtime.id, bootId: bootId(), link };
    return starts.check(message, context);
  };
  const claim = await claimInteraction(crypto.randomUUID(), verify);
  if (claim.status !== "CLAIMED") return refuse(claim.status);
  const lease = leases.open({
    linkId: link.linkId,
    interactId: claim.interactId,
    url: message.url,
  });
  const { allowlist } = await provision();
  const on = { offPolicy: () => revokeLater("TARGET_OFF_POLICY"), gone: revokeLater };
  const opened = await openTab(
    { interactId: claim.interactId, url: message.url, origins: allowlist },
    on,
  ).then(
    (tabId) => ({ tabId }),
    (error) => ({ error: String(error) }),
  );
  if (opened.error) {
    stats.errors.push(opened.error);
    await end(leases.revoke("TAB_FAILED"));
    return refuse("TAB_FAILED");
  }
  stats.started += 1;
  return { ok: true, leaseId: lease.leaseId, interactId: lease.interactId, ...limits };
};

const failedEvent = async (error, message) => {
  if (String(error?.message) !== "INPUT_UNKNOWN") throw error;
  await end(leases.revoke("INPUT_UNKNOWN"));
  return refuse("INPUT_UNKNOWN", { leaseId: message.leaseId, seq: message.seq });
};

const onLease = async (message, link) => {
  const refusal = leases.admit(message, link.linkId);
  if (refusal) {
    await end(refusal.ended);
    return refuse(refusal.code, refusal.reason ? { reason: refusal.reason } : {});
  }
  const { leaseId, seq } = message;
  if (message.type === "INTERACT_RENEW") leases.renew();
  else if (message.type === "INTERACT_STOP") await end(leases.revoke("STOPPED"));
  else if (message.type === "INTERACT_REFRESH") {
    if (!observed()) return refuse("NOT_OBSERVED", { leaseId, seq });
    await refresh();
  } else return event(message).catch((error) => failedEvent(error, message));
  return { ok: true, leaseId, seq };
};

const dispatch = async (message, link) => {
  const invalid = inputError(message);
  if (invalid) return refuse(invalid);
  if (message.type === "INTERACT_CHALLENGE") return challenge(link);
  if (message.type === "INTERACT_START") return start(message, link);
  return onLease(message, link);
};

const replyType = (message) =>
  INPUT_TYPES.includes(message?.type) ? `${message.type}-reply` : "INPUT-reply";

/** One input.v1 message from `link`; messages are handled one at a time, in arrival order. */
export const input = (message, link) =>
  serial(async () => {
    // Every message gets exactly one reply, so the master's FIFO pairing never slips.
    const reply = await dispatch(message, link).catch((error) => {
      stats.errors.push(String(error));
      return refuse("WORKER_ERROR");
    });
    return { type: replyType(message), ...reply };
  });

/** A closed input channel or link ends its lease and voids its outstanding challenges. */
export const interactLinkClosed = (linkId) =>
  serial(async () => {
    starts.forget(linkId);
    if (leases.current()?.linkId === linkId) await end(leases.revoke("LINK_CLOSED"));
  });

/** Revokes from outside a message: an off-policy commit, a closed tab, a detach. */
function revokeLater(reason) {
  void serial(() => end(leases.revoke(reason)));
}

let refreshedAt = 0;
function observed() {
  const capture = captureStats();
  return capture.state === "ACTIVE" && capture.mode === "interact";
}
const quiet = () => {
  if (!observed()) return false;
  const since = Date.now() - Math.max(frames.latest()?.sentAt ?? 0, refreshedAt);
  return since > QUIET_MS;
};

setInterval(() => {
  if (leases.expired()) void serial(() => end(leases.revoke("LEASE_EXPIRED")));
  else if (leases.current() && quiet()) {
    refreshedAt = Date.now();
    void serial(() => refresh().catch(() => false));
  }
}, TICK_MS);

export const interactLab = {
  // The worker-local stop: it holds across starts until `clear`.
  stop: () =>
    serial(async () => {
      await chrome.storage.local.set({ interactStop: true });
      await end(leases.revoke("WORKER_STOP"));
      return true;
    }),
  clear: () => chrome.storage.local.remove("interactStop").then(() => true),
  state: () => {
    const { tab, held, stats: tabStats } = tabState();
    const state = { lease: leases.current(), claim: claimed(), stats, limits };
    return { ...state, starts: starts.sizes(), frames: frames.size(), tab, held, tabStats };
  },
  resize: (width, height) => resize(width, height).then(() => true),
  isOpen,
};
