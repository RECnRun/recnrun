// W7 slices A and B: link-bound interactive sessions on the worker's own tab, sharing the claim.
import { bootId, captureStats } from "./capture.js";
import { createStartCheck } from "./input-check.js";
import { INPUT_TYPES, inputError } from "./input-schema.js";
import { createEvents } from "./interact-events.js";
import { createFrames, geometryOf } from "./interact-frames.js";
import { createGate } from "./interact-gate.js";
import { createLeases } from "./interact-lease.js";
import { closeTab, isOpen, openTab, recover, refresh } from "./interact-tab.js";
import { holding, insertText, key, liveDocument, mouse, releaseHeld } from "./interact-tab.js";
import { resize, tabState } from "./interact-tab.js";
import { setSentHook } from "./observe.js";
import { blockInteraction, claimInteraction, claimed, releaseInteraction } from "./runner.js";

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
// The stop holds in memory at once, and in storage across service worker restarts.
let stopping = false;
const latched = async () =>
  stopping || (await chrome.storage.local.get("interactStop")).interactStop === true;

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

// A tab whose close is not confirmed keeps the claim; the tick tries again.
let cleanup = Promise.resolve();
/** @type {Promise<string | null>} */
let opening = Promise.resolve(null);
let unclosed = null;
const LEFTOVER = "leftover-tab";

const settle = async ({ id, close }) => {
  await opening;
  const closed = await close().catch((error) => {
    stats.errors.push(String(error));
    return false;
  });
  unclosed = closed ? null : { id, close };
  if (closed) releaseInteraction(id);
};

/** Ends the lease at once: no queued event acts after this. The tab closes, then the claim frees. */
const finish = (ended) => {
  if (!ended) return cleanup;
  count(stats.revoked, ended.reason);
  frames.clear();
  const { leaseId, interactId, reason } = ended;
  const revoked = { type: "INTERACT_REVOKED", leaseId, interactId, reason };
  cleanup = cleanup
    .then(() => settle({ id: interactId, close: closeTab }))
    .then(() => push(ended.linkId, revoked));
  return cleanup;
};
const revoke = (reason) => finish(leases.revoke(reason));

// A service worker that died left its tab: until it is gone, nothing claims the worker.
const recovering = recover().catch(() => false);
cleanup = recovering.then((closed) => {
  if (closed) return;
  blockInteraction(LEFTOVER);
  unclosed = { id: LEFTOVER, close: recover };
});

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

/** True while `leaseId` is the live, unexpired lease; an expired one is revoked here. */
const authorized = (leaseId) => {
  const lease = leases.current();
  if (!lease || lease.leaseId !== leaseId) return false;
  if (!leases.expired()) return true;
  void revoke("LEASE_EXPIRED");
  return false;
};

const gate = createGate({ onOverload: (code) => void revoke(code) });
const serial = (work) => gate.chain(work);
const tabOps = { holding, insertText, key, liveDocument, mouse, releaseHeld };
const event = createEvents({ frames, refuse, revoke, serial, stats, tab: tabOps, authorized });

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
  await recovering;
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
  const on = { offPolicy: () => revoke("TARGET_OFF_POLICY"), gone };
  const target = { interactId: claim.interactId, url: message.url, origins: allowlist };
  opening = openTab(target, on).then(
    () => null,
    (error) => String(error),
  );
  const failed = await opening;
  if (failed) {
    stats.errors.push(failed);
    await revoke("TAB_FAILED");
    return refuse("TAB_FAILED");
  }
  // A link lost or a stop while the tab opened has already ended this lease.
  if (leases.current()?.leaseId !== lease.leaseId) return refuse("SESSION_REVOKED");
  stats.started += 1;
  return { ok: true, leaseId: lease.leaseId, interactId: lease.interactId, ...limits };
};

const failedEvent = async (error, message) => {
  if (String(error?.message) !== "INPUT_UNKNOWN") throw error;
  void revoke("INPUT_UNKNOWN");
  return refuse("INPUT_UNKNOWN", { leaseId: message.leaseId, seq: message.seq });
};

const onLease = async (message, link) => {
  const refusal = leases.admit(message, link.linkId);
  if (refusal) {
    void finish(refusal.ended);
    return refuse(refusal.code, refusal.reason ? { reason: refusal.reason } : {});
  }
  const { leaseId, seq } = message;
  if (message.type === "INTERACT_RENEW") leases.renew();
  else if (message.type === "INTERACT_STOP") await revoke("STOPPED");
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

// A stop from the lease's own link acts on arrival, ahead of anything queued before it.
const stopNow = (message, link) => {
  if (message?.type !== "INTERACT_STOP" || inputError(message)) return null;
  const lease = leases.current();
  if (lease?.leaseId !== message.leaseId || lease.linkId !== link.linkId) return null;
  const { leaseId, seq } = message;
  return revoke("STOPPED").then(() => ({ ok: true, leaseId, seq }));
};

/** One input.v1 message from `link`; messages are handled one at a time, in arrival order. */
export const input = (message, link) => {
  const stopped = stopNow(message, link);
  // Every message gets exactly one reply, so the master's FIFO pairing never slips.
  const reply = (body) => ({ type: replyType(message), ...body });
  const handle = async () =>
    reply(
      await (stopped ??
        dispatch(message, link).catch((error) => {
          stats.errors.push(String(error));
          return refuse("WORKER_ERROR");
        })),
    );
  const { leaseId, seq } = message ?? {};
  return gate.serial(handle, (code) => {
    void revoke(code);
    return reply(refuse(code, { leaseId, seq }));
  });
};

/** A closed input channel or link ends its lease at once and voids its outstanding challenges. */
export const interactLinkClosed = (linkId) => {
  starts.forget(linkId);
  return leases.current()?.linkId === linkId ? revoke("LINK_CLOSED") : cleanup;
};

/** The worker-local stop: it holds across starts until `clear`. */
const stopWorker = async () => {
  stopping = true;
  const done = revoke("WORKER_STOP");
  await chrome.storage.local.set({ interactStop: true });
  await done;
};

/** A lost tab or detach ends the lease; the owner's Cancel on the infobar stops the worker. */
function gone(reason) {
  if (reason === "WORKER_STOP") void stopWorker();
  else void revoke(reason);
}

// An unconfirmed close is tried again, one attempt at a time.
const retryClose = () => {
  const pending = unclosed;
  unclosed = null;
  cleanup = cleanup.then(() => settle(pending));
};

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
  if (leases.expired()) void revoke("LEASE_EXPIRED");
  else if (unclosed) retryClose();
  else if (leases.current() && quiet()) {
    refreshedAt = Date.now();
    void serial(() => refresh().catch(() => false));
  }
}, TICK_MS);

export const interactLab = {
  stop: () => stopWorker().then(() => true),
  clear: () => {
    stopping = false;
    return chrome.storage.local.remove("interactStop").then(() => true);
  },
  state: () => {
    const { tab, held, stats: tabStats } = tabState();
    const state = { lease: leases.current(), claim: claimed(), stats, limits };
    return { ...state, starts: starts.sizes(), frames: frames.size(), tab, held, tabStats };
  },
  resize: (width, height) => resize(width, height).then(() => true),
  isOpen,
};
